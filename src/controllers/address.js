/* BEGIN: EXPERIMENTAL/DEPRECATED */

var boom = require('boom')
var braveHapi = require('../brave-hapi')
var braveJoi = require('../brave-joi')
var bson = require('bson')
var Joi = require('joi')
var stripe
var underscore = require('underscore')

var v1 = {}

/*
   GET /v1/address/{address}/validate
 */

v1.validate =
{ handler: (runtime) => {
  return async (request, reply) => {
    var balances, paymentId, state, wallet
    var debug = braveHapi.debug(module, request)
    var address = request.params.address
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    paymentId = wallet.paymentId
    balances = wallet.balances
    if (!balances) {
      balances = await runtime.wallet.balances(wallet)

      state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { balances: balances } }
      await wallets.update({ paymentId: paymentId }, state, { upsert: true })

      await runtime.queue.send(debug, 'wallet-report', underscore.extend({ paymentId: paymentId }, state.$set))
    }

    reply({ satoshis: balances.confirmed > balances.unconfirmed ? balances.confirmed : balances.unconfirmed })
  }
},

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Determines the validity of a BTC address',
  tags: [ 'api' ],

  validate: {
    params: { address: braveJoi.string().base58().required().description('BTC address') },
    query: { access_token: Joi.string().guid().optional() }
  },

  response: {
    schema: Joi.object().keys({
      satoshis: Joi.number().integer().min(0).optional().description('the wallet balance in satoshis')
    })
  }
}

/*
   PUT /v1/address/{address}/validate
 */

// currently hard-coded to stripe in production...

var compareCharge = async (debug, actor, chargeId, amount, currency) => {
  return new Promise((resolve, reject) => {
    if (actor !== 'authorize.stripe') {
      if ((process.env.NODE_ENV !== 'production') && (process.env.NODE_ENV === actor)) return resolve()

      return reject(new Error('invalid result.actor'))
    }

    stripe.charges.retrieve(chargeId, (err, charge) => {
      if (err) return reject(err)

      debug('retrieve', charge)
      if ((charge.object !== 'charge') || (charge.amount_refunded !== 0) || (charge.refunded) || (!charge.paid) ||
          (charge.status !== 'succeeded')) {
        return resolve('invalid charge')
      }

      charge.amount = (charge.amount / 100).toFixed(2)
      charge.currency = charge.currency.toUpperCase()

      if ((charge.amount === amount.toFixed(2)) && (charge.currency === currency)) return resolve()

      resolve('amount/currency mismatch: server=' + charge.amount + '/' + charge.currency + ' vs. client=' + amount + '/' +
              currency)
    })
  })
}

v1.populate =
{ handler: (runtime) => {
  return async (request, reply) => {
    var rate, result, satoshis, state, wallet
    var debug = braveHapi.debug(module, request)
    var address = request.params.address
    var actor = request.payload.actor
    var amount = request.payload.amount
    var currency = request.payload.currency
    var fee = request.payload.fee
    var populates = runtime.db.get('populates', debug)
    var transactionId = request.payload.transactionId
    var wallets = runtime.db.get('wallets', debug)

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    try {
      result = await compareCharge(debug, actor, transactionId, amount, currency)
      if (result) return reply(boom.badData(result))
    } catch (ex) {
      runtime.notify(debug, { text: 'retrieve error: ' + ex.toString() })
      debug('retrieve', ex)
      return boom.badGateway(ex.toString())
    }
    if (amount <= fee) return reply(boom.badData('amount/fee mismatch'))

    rate = runtime.wallet.rates[currency.toUpperCase()]
    satoshis = Math.round((amount / rate) * 1e8)

    state = {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $set: underscore.extends({ paymentId: wallet.paymentId, satoshis: satoshis },
                               underscore.omit(request.payload, [ 'transactionId' ]))
    }
    await populates.update({ address: address, transactionId: transactionId }, state, { upsert: true })

    await runtime.queue.send(debug, 'population-report',
                             underscore.extend({ paymentId: wallet.paymentId, address: address, satoshis: satoshis },
                                               request.payload))
    reply({ satoshis: satoshis })
  }
},

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Validates the "attempt to populate" a BTC address',
  tags: [ 'api' ],

  validate: {
    params: { address: braveJoi.string().base58().required().description('BTC address') },
    query: { access_token: Joi.string().guid().optional() },
    payload: {
      actor: Joi.string().required().description('authorization agent'),
      transactionId: Joi.string().required().description('transaction-identifier'),
      fee: Joi.number().min(0).required().description('the processing fee in fiat currency'),
      amount: Joi.number().min(5).required().description('the payment amount in fiat currency'),
      currency: braveJoi.string().currencyCode().required().default('USD').description('the fiat currency')
    }
  },

  response:
    { schema: { satoshis: Joi.number().integer().min(0).required().description('the populated amount in satoshis') } }
}

/*
   PATCH /v1/address/{address}/{transactionId}
 */

v1.update =
{ handler: (runtime) => {
  return async (request, reply) => {
    var balances, entry, paymentId, satoshis, state, wallet
    var address = request.params.address
    var eventId = request.payload.eventId
    var status = request.payload.status
    var transactionId = request.params.transactionId
    var debug = braveHapi.debug(module, request)
    var populates = runtime.db.get('populates', debug)
    var wallets = runtime.db.get('wallets', debug)

    var done = async () => {
      await runtime.queue.send(debug, 'population-update',
                               underscore.extend({ paymentId: paymentId }, request.params, request.payload))
      reply({})
    }

    wallet = await wallets.findOne({ address: address })
    if (!wallet) return reply(boom.notFound('invalid address: ' + address))

    paymentId = wallet.paymentId
    entry = await populates.findOne({ address: address, transactionId: transactionId })
    if (!entry) {
      debug('update', { params: request.params, payload: request.payload })
      runtime.notify(debug, { text: 'no such transaction: ' + transactionId })
      return done()
    }

    if (entry.status === 'closed') {
      debug('update', { params: request.params, payload: request.payload })
      runtime.notify(debug, { text: 'transaction already closed: ' + transactionId })
      return done()
    }

    state = {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $set: { status: status, eventId: eventId }
    }
    await populates.update({ address: address, transactionId: transactionId }, state, { upsert: true })
    if (status === 'closed') return done()

    balances = await runtime.wallet.balances(wallet)
    satoshis = balances.confirmed > balances.unconfirmed ? balances.confirmed : balances.unconfirmed

    wallet = await wallets.findOneAndUpdate({
      $and: [
        { address: address },
        { refundSatoshis: { $exists: true, $le: satoshis - entry.satoshis } }
      ]
    }, {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $inc: { refundSatoshis: entry.satoshis }
    }, { upsert: false })

    if (wallet) request.payload.status = 'closed'
    done()
  }
},

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Updates the "attempt to populate" a BTC address',
  tags: [ 'api' ],

  validate: {
    params: {
      address: braveJoi.string().base58().required().description('BTC address'),
      transactionId: Joi.string().required().description('transaction-identifier')
    },
    query: { access_token: Joi.string().guid().optional() },
    payload: {
      status: Joi.string().required().description('updated status'),
      actor: Joi.string().required().description('authorization agent'),
      eventId: Joi.string().required().description('event-identifier')
    }
  },

  response:
    { schema: Joi.object().length(0) }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/address/{address}/validate').whitelist().config(v1.validate),
  braveHapi.routes.async().put().path('/v1/address/{address}/validate').whitelist().config(v1.populate),
  braveHapi.routes.async().patch().path('/v1/address/{address}/{transactionId}').whitelist().config(v1.update)
]

module.exports.initialize = async (debug, runtime) => {
  stripe = require('stripe')(runtime.config.payments.stripe.secretKey)

  runtime.db.checkIndices(debug, [
    {
      category: runtime.db.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: {
        paymentId: '',
        address: '',
        provider: '',
        balances: {},
        paymentStamp: 0,
        refundSatoshis: 0,
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { paymentId: 1 }, { address: 1 } ],
      others: [ { provider: 1 }, { paymentStamp: 1 }, { refundSatoshis: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.db.get('populates', debug),
      name: 'populates',
      property: 'transactionId',
      empty: {
        transactionId: '',
        paymentId: '',
        address: '',
        actor: '',
        status: '',
        eventId: '',
        amount: '',
        currency: '',
        satoshis: 0,
        fee: 0,
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { transactionId: 1 } ],
      others: [ { paymentId: 1 }, { address: 1 }, { actor: 1 }, { status: 1 }, { eventId: 1 }, { amount: 1 }, { currency: 1 },
                { satoshis: 1 }, { fee: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('population-report')
  await runtime.queue.create('population-update')
  await runtime.queue.create('wallet-report')
}

/* END: EXPERIMENTAL/DEPRECATED */
