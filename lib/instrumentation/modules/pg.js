'use strict'

var semver = require('semver')
var sqlSummary = require('sql-summary')
var debug = require('debug')('opbeat')
var shimmer = require('../shimmer')

module.exports = function (pg, opbeat, version) {
  if (!semver.satisfies(version, '>=4.0.0 <7.0.0')) {
    debug('pg version %s not suppoted - aborting...', version)
    return pg
  }

  patchClient(pg.Client, 'pg.Client', opbeat)

  // Trying to access the pg.native getter will trigger and log the warning
  // "Cannot find module 'pg-native'" to STDERR if the module isn't installed.
  // Overwriting the getter we can lazily patch the native client only if the
  // user is acually requesting it.
  var getter = pg.__lookupGetter__('native')
  if (getter) {
    delete pg.native
    // To be as true to the original pg module as possible, we use
    // __defineGetter__ instead of Object.defineProperty.
    pg.__defineGetter__('native', function () {
      var native = getter()
      if (native && native.Client) {
        patchClient(native.Client, 'pg.native.Client', opbeat)
      }
      return native
    })
  }

  return pg
}

function patchClient (Client, klass, opbeat) {
  debug('shimming %s.prototype.query', klass)
  shimmer.wrap(Client.prototype, 'query', wrapQuery)

  function wrapQuery (orig, name) {
    return function wrappedFunction (sql) {
      var trace = opbeat.buildTrace()
      var uuid = trace && trace.transaction._uuid

      if (sql && typeof sql.text === 'string') sql = sql.text

      debug('intercepted call to %s.prototype.%s %o', klass, name, { uuid: uuid, sql: sql })

      if (trace) {
        var args = arguments
        var index = args.length - 1
        var cb = args[index]

        if (this._opbeatStackObj) {
          trace.customStackTrace(this._opbeatStackObj)
          this._opbeatStackObj = null
        }

        if (Array.isArray(cb)) {
          index = cb.length - 1
          cb = cb[index]
        }

        if (typeof sql === 'string') {
          trace.extra.sql = sql
          trace.start(sqlSummary(sql), 'db.postgresql.query')
        } else {
          debug('unable to parse sql form pg module (type: %s)', typeof sql)
          trace.start('SQL', 'db.postgresql.query')
        }

        if (typeof cb === 'function') {
          args[index] = end
          return orig.apply(this, arguments)
        } else {
          cb = null
          var query = orig.apply(this, arguments)
          query.on('end', end)
          query.on('error', end)
          return query
        }
      } else {
        return orig.apply(this, arguments)
      }

      function end () {
        debug('intercepted end of %s.prototype.%s %o', klass, name, { uuid: uuid })
        trace.end()
        if (cb) return cb.apply(this, arguments)
      }
    }
  }
}
