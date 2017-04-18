var boom = require('boom')
var braveHapi = require('../brave-hapi')
var Joi = require('joi')
var Readable = require('stream').Readable
var underscore = require('underscore')
var url = require('url')
var uuid = require('uuid')

var v1 = {}
var v2 = {}

/*
   GET /v1/reports/file/{reportId}
 */

v1.getFile =
{ handler: (runtime) => {
  return async function (request, reply) {
    var file, reader, writer
    var debug = braveHapi.debug(module, request)
    var reportId = request.params.reportId

    file = await runtime.db.file(reportId, 'r')
    if (!file) return reply(boom.notFound('no such report: ' + reportId))

    reader = runtime.db.source({ filename: reportId })
    reader.on('error', (err) => {
      debug('getFile error', err)
      reply(boom.badImplementation('Sic transit gloria mundi: ' + reportId))
    }).on('open', () => {
      debug('getFile open', underscore.pick(file, [ 'contentType', 'metadata' ]))
      writer = reply(new Readable().wrap(reader))
      if (file.contentType) {
        console.log('contentType=' + file.contentType)
        writer = writer.type(file.contentType)
      }
      underscore.keys(file.metadata || {}).forEach((header) => {
        console.log('header= ' + header + ': ' + file.metadata[header])
        writer = writer.header(header, file.metadata[header])
      })
    })
  }
},

  description: 'Gets a report file',
  tags: [ 'api' ],

  validate:
    { params: { reportId: Joi.string().guid().required().description('the report identifier') } }
}

v2.publisher = {}

/*
   GET /v2/reports/publisher/rulesets
 */

v2.publisher.rulesets =
{ handler: (runtime) => {
  return async function (request, reply) {
    var authority = request.auth.credentials.provider + ':' + request.auth.credentials.profile.username
    var reportId = uuid.v4().toLowerCase()
    var reportURL = url.format(underscore.defaults({ pathname: '/v1/reports/file/' + reportId }, runtime.config.server))
    var debug = braveHapi.debug(module, request)

    await runtime.queue.send(debug, 'report-publisher-rulesets',
                             underscore.defaults({ reportId: reportId, reportURL: reportURL, authority: authority },
                                                 request.query))
    reply({ reportURL: reportURL })
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'devops' ],
    mode: 'required'
  },

  description: 'Returns information about publisher rulesets',
  tags: [ 'api' ],

  validate: {
    query: {
      exclude: Joi.boolean().optional().description('excluded from auto-include list'),
      facet: Joi.string().valid('domain', 'SLD', 'TLD').optional().description('the entry type'),
      tag: Joi.string().valid('ads', 'adult', 'aggregators', 'brave', 'btc-exchanges', 'commerce', 'contentStores',
                              'government', 'imageStores', 'machineTranslations', 'messageApps', 'news', 'platforms',
                              'redirection', 'search', 'services').optional().description('taxonomy tag'),
      format: Joi.string().valid('json', 'csv').optional().default('csv').description('the format of the report')
    }
  },

  response:
    { schema: Joi.object().keys().unknown(true) }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/reports/file/{reportId}').config(v1.getFile),
  braveHapi.routes.async().path('/v2/reports/publisher/rulesets').config(v2.publisher.rulesets)
]

module.exports.initialize = async function (debug, runtime) {
  await runtime.queue.create('report-publisher-rulesets')
}
