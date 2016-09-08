var braveHapi = require('../brave-hapi')
var bson = require('bson')
var Joi = require('joi')
var ledgerExchange // not a package, yet...

var v1 = {}

var rulesetId = 3

ledgerExchange = {
  providers: {
    AU: {
      titleText: 'Create an account on CoinJar',
      buttonText: 'Create',
      buttonURL: 'https://www.coinjar.com/'
    },

    BR: {
      titleText: 'Create an account on BitcoinToYou',
      buttonText: 'Create',
      buttonURL: 'https://www.bitcointoyou.com/'
    },

    CA: {
      titleText: 'Create an account on QuadrigaCX',
      buttonText: 'Create',
      buttonURL: 'https://www.quadrigacx.com/'
    },

    ID: {
      titleText: 'Create an account on BitX',
      buttonText: 'Create',
      buttonURL: 'https://www.bitx.co/'
    },

    IN: {
      titleText: 'Create an account on Coinsecure',
      buttonText: 'Create',
      buttonURL: 'https://coinsecure.in/'
    },

    TW: {
      titleText: 'Create an account on 247exchange',
      buttonText: 'Create',
      buttonURL: 'https://www.247exchange.com/'
    },

    US: {
      titleText: 'Use your debit or credit card',
      buttonText: 'Buy with Coinbase',
      buttonURL: 'https://www.coinbase.com/',
      bitcoinURL: 'https://www.coinbase.com/handler?u=%s'
    }
  },

  schema:
    Joi.object().pattern(/^[A-Z][A-Z]/,
      Joi.object().keys({
        titleText: Joi.string().required().description('the text above the image'),
        imageURL: Joi.string().uri({ scheme: [ /https?/, /data/ ] }).optional().description('the image'),
        buttonText: Joi.string().required().description('the text in the button below the image'),
        buttonURL: Joi.string().uri({ scheme: [ /https?/ ] }).required().description('the buy button'),
        bitcoinURL: Joi.string().uri({ scheme: [ /https?/ ] }).optional().description('add link handler to your browser')
      })
    )
}

var cubits = [ 'AT',
               'BA', 'BE', 'BG', 'BR',
               'CA', 'CH', 'CY', 'CZ',
               'DE', 'DK',
               'EE', 'ES',
               'FI', 'FR',
               'GB', 'GR',
               'HR', 'HU',
               'IE', 'IS', 'IT',
               'JP',
               'KR',
               'LI', 'LT', 'LU', 'LV',
               'MT', 'MX',
               'NL', 'NO', 'NZ',
               'PO', 'PT',
               'RO', 'RU',
               'SE', 'SG', 'SI', 'SK',
               'TR',
               'UA',
               'ZA' ]
cubits.forEach((iso3166) => {
  ledgerExchange.providers[iso3166] = { titleText: 'Create an account on Cubits',
                                        buttonText: 'Create',
                                        buttonURL: 'https://cubits.com/'
                                      }
})

/*
   GET /v1/exchange/providers
 */

v1.read =
{ handler: function (runtime) {
  return async function (request, reply) {
    reply(ledgerExchange.providers)
  }
},

  description: 'Returns the list of ledger exchange providers',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: ledgerExchange.schema }
}

/*
   POST /v1/exchange/providers
 */

v1.create =
{ handler: function (runtime) {
  return async function (request, reply) {
    var state
    var debug = braveHapi.debug(module, request)
    var rulesets = runtime.db.get('rulesets', debug)

    state = { $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { rules: request.payload, type: 'exchange/providers' }
            }
    await rulesets.update({ rulesetId: rulesetId }, state, { upsert: true })
    ledgerExchange.providers = request.payload

    reply({})
  }
},

  auth:
    { strategy: 'session',
      scope: [ 'ledger' ],
      mode: 'required'
    },

  description: 'Defines the list of ledger exchange providers',
  tags: [ 'api' ],

  validate:
    { payload: ledgerExchange.schema },

  response:
    { schema: Joi.object().length(0) }
}

module.exports.routes = [
  braveHapi.routes.async().get().path('/v1/exchange/providers').config(v1.read),
  braveHapi.routes.async().post().path('/v1/exchange/providers').config(v1.create)
]

module.exports.initialize = async function (debug, runtime) {
  var entry, validity
  var rulesets = runtime.db.get('rulesets', debug)

  runtime.db.checkIndices(debug,
  [ { category: rulesets,
      name: 'rulesets',
      property: 'rulesetId',
      empty: { rulesetId: 0, type: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { rulesetId: 1 } ],
      others: [ { type: 1 }, { timestamp: 1 } ]
    }
  ])

  entry = await rulesets.findOne({ rulesetId: rulesetId })
  if (entry) ledgerExchange.providers = entry.rules
  validity = Joi.validate(ledgerExchange.providers, ledgerExchange.schema)
  if (validity.error) throw new Error(validity.error)
}
