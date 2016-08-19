var anonize = require('node-anonize2-relic-emscripten')
var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
var timestamp = require('monotonic-timestamp')
var underscore = require('underscore')

var v1 = {}

/*
   GET /v1/wallet/{paymentId}
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    var balances, result, wallet
    var amount = request.query.amount
    var balanceP = request.query.balance
    var currency = request.query.currency
    var debug = braveHapi.debug(module, request)
    var paymentId = request.params.paymentId.toLowerCase()
    var refreshP = request.query.refresh
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    result = { paymentStamp: wallet.paymentStamp || 0,
               rates: currency ? underscore.pick(runtime.wallet.rates, [ currency.toUpperCase() ]) : runtime.wallet.rates
             }
    if (balanceP || refreshP) {
      balances = await runtime.wallet.balances(wallet)
      underscore.extend(result, { satoshis: balances.confirmed,
                                  balance: (balances.confirmed / 1e8).toFixed(4),
                                  unconfirmed: (balances.unconfirmed / 1e8).toFixed(4)
                                 })
    }
    if ((amount) && (currency)) {
      underscore.extend(result, runtime.wallet.paymentInfo(wallet, amount, currency))
      if (refreshP) result.unsignedTx = await runtime.wallet.unsignedTx(wallet, amount, currency, balances.confirmed)
    }

    reply(result)
  }
},

  description: 'Returns information about BTC wallet associated with the user',
  tags: [ 'api' ],

  validate:
    { params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
      query: { amount: Joi.number().positive().optional().description('the payment amount'),
               balance: Joi.boolean().optional().description('return balance information'),
               currency: braveJoi.string().currencyCode().optional().description('the payment currency'),
               refresh: Joi.boolean().optional().description('return balance and transaction information')
             }
    },

  response:
    { schema: Joi.object().keys(
      {
        balance: Joi.number().min(0).optional().description('the (confirmed) wallet balance in BTC'),
        unconfirmed: Joi.number().min(0).optional().description('the unconfirmed wallet balance in BTC'),
        buyURL: Joi.string().uri({ scheme: /https?/ }).optional().description('the URL for payment interaction'),
        buyURLExpires: Joi.number().min(0).optional().description('the expiration date of the payment URL'),
        paymentStamp: Joi.number().min(0).required().description('timestamp of the last successful payment'),
        rates: Joi.object().optional().description('current exchange rates from BTC to various currencies'),
        satoshis: Joi.number().integer().min(0).optional().description('the wallet balance in satoshis'),
        unsignedTx: Joi.object().optional().description('unsigned transaction')
      })
    }
}

v1.write =
{ handler: function (runtime) {
  return async function (request, reply) {
    var fee, now, params, result, state, surveyor, surveyorIds, votes, wallet
    var debug = braveHapi.debug(module, request)
    var paymentId = request.params.paymentId.toLowerCase()
    var signedTx = request.payload.signedTx
    var surveyorId = request.payload.surveyorId
    var viewingId = request.payload.viewingId
    var surveyors = runtime.db.get('surveyors', debug)
    var viewings = runtime.db.get('viewings', debug)
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    surveyor = await surveyors.findOne({ surveyorId: surveyorId })
    if (!surveyor) return reply(boom.notFound('no such surveyor: ' + surveyorId))

    result = await runtime.wallet.submitTx(wallet, signedTx)
/*
    { status   : 'accepted'
    , tx       : '...'
    , hash     : '...'
    , instant  : false,
    , fee      : 7969
    , address  : '...'
    , satoshis : 868886
    }
}
 */
    if (result.status !== 'accepted') return reply(boom.badData(result.status))

    now = timestamp()
    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { paymentStamp: now }
            }
    await wallets.update({ paymentId: paymentId }, state, { upsert: true })

    params = surveyor.payload.adFree
    votes = Math.floor(((result.fee + result.satoshis) / params.satoshis) * params.votes)
    if (votes < 1) votes = 1
    fee = result.fee

    if (!surveyor.surveyors) surveyor.surveyors = []
    if (votes > surveyor.surveyors.length) {
      state = { payload: request.payload, result: result, votes: votes, message: 'insufficient surveyors' }
      debug('wallet', state)
      runtime.newrelic.noticeError(new Error('insufficent surveyors'), state)
    }

    surveyorIds = underscore.shuffle(surveyor.surveyors).slice(0, votes)
    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { surveyorId: surveyorId,
                      uId: anonize.uId(viewingId),
                      surveyorIds: surveyorIds,
                      satoshis: result.satoshis,
                      count: votes
                    }
            }
    await viewings.update({ viewingId: viewingId }, state, { upsert: true })

    result = { paymentStamp: now, satoshis: result.satoshis, votes: votes, hash: result.hash }
    reply(result)

    await runtime.queue.send(debug, 'contribution-report', underscore.extend({ paymentId: paymentId,
                                                                               surveyorId: surveyorId,
                                                                               viewingId: viewingId,
                                                                               fee: fee }, result))
  }
},

  description: 'Makes a contribution using the BTC wallet associated with the user',
  tags: [ 'api' ],

  validate:
    { params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
      payload:
      { viewingId: Joi.string().guid().required().description('unique-identifier for voting'),
        surveyorId: Joi.string().required().description('the identity of the surveyor'),
        signedTx: Joi.string().hex().required().description('signed transaction')
      }
    },

  response:
    { schema: Joi.object().keys(
      {
        paymentStamp: Joi.number().min(0).required().description('timestamp of the last successful contribution'),
        satoshis: Joi.number().integer().min(0).optional().description('the contribution amount in satoshis'),
        votes: Joi.number().integer().min(0).optional().description('the corresponding number of publisher votes'),
        hash: Joi.string().hex().required().description('transaction hash')
      })
    }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/wallet/{paymentId}').config(v1.read),
  braveHapi.routes.async().put().path('/v1/wallet/{paymentId}').config(v1.write)
]

module.exports.initialize = async function (debug, runtime) {
  runtime.db.checkIndices(debug,
  [ { category: runtime.db.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: { paymentId: '', address: '', provider: '', paymentStamp: 0, timestamp: bson.Timestamp.ZERO },
      unique: [ { paymentId: 0 } ],
      others: [ { address: 0 }, { provider: 1 }, { paymentStamp: 1 }, { timestamp: 1 } ]
    },
    { category: runtime.db.get('viewings', debug),
      name: 'viewings',
      property: 'viewingId',
      empty: { viewingId: '', uId: '', satoshis: 0, count: 0, surveyorIds: [], timestamp: bson.Timestamp.ZERO },
      unique: [ { viewingId: 0 }, { uId: 0 } ],
      others: [ { satoshis: 1 }, { count: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('contribution-report')
}