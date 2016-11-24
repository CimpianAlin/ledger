var cron = require('cron-parser')
var moment = require('moment')
var underscore = require('underscore')
var utilities = require('../controllers/surveyor.js')

var interval

var daily = async function (debug, runtime) {
  var entries, next
  var surveyorType = 'contribution'
  var surveyors = runtime.db.get('surveyors', debug)

  debug('daily', 'running')

  entries = await surveyors.find({ surveyorType: surveyorType, active: true }, { limit: 100, sort: { timestamp: -1 } })
  entries.forEach(async function (entry) {
    var payload, surveyor, validity

    try {
      validity = utilities.validate(surveyorType, entry.payload)
      if (validity.error) return debug('daily', 'unable to create surveyorType=' + surveyorType + ': ' + validity.error)

      payload = utilities.enumerate(runtime, surveyorType, entry.payload)
      if (!payload) return debug('daily', 'no available currencies' + JSON.stringify(entry.payload))

      surveyor = await utilities.create(debug, runtime, surveyorType, payload)
      if (!surveyor) return debug('daily', 'unable to create surveyorType=' + surveyorType)
    } catch (ex) {
      return debug('daily', 'error ' + ex.toString() + ' ' + ex.stack)
    }

    debug('daily', 'created ' + surveyorType + ' surveyorID=' + surveyor.surveyorId)
  })

  next = interval.next().getTime()
  setTimeout(function () { daily(debug, runtime) }, next - underscore.now())
  debug('daily', 'running again ' + moment(next).fromNow())
}

var exports = {}

exports.initialize = async function (debug, runtime) {
  var next, schedule

  if ((typeof process.env.DYNO !== 'undefined') && (process.env.DYNO !== 'worker.1')) return

  await require('../controllers/registrar.js').initialize(debug, runtime)
  await utilities.initialize(debug, runtime)

/* from https://github.com/harrisiirak/cron-parser

*    *    *    *    *    *
┬    ┬    ┬    ┬    ┬    ┬
│    │    │    │    │    |
│    │    │    │    │    └ day of week (0 - 7) (0 or 7 is Sun)
│    │    │    │    └───── month (1 - 12)
│    │    │    └────────── day of month (1 - 31)
│    │    └─────────────── hour (0 - 23)
│    └──────────────────── minute (0 - 59)
└───────────────────────── second (0 - 59, optional)

 */

  schedule = process.env.SURVEYOR_CRON_SCHEDULE || '0 0 0 * * 0,3,5'

  interval = cron.parseExpression(schedule, { })
  next = interval.next().getTime()
  setTimeout(function () { daily(debug, runtime) }, next - underscore.now())
  debug('daily', 'running ' + moment(next).fromNow())
}

exports.workers = {
}

module.exports = exports
