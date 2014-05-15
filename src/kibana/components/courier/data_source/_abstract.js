define(function (require) {
  var inherits = require('utils/inherits');
  var _ = require('lodash');
  var nextTick = require('utils/next_tick');

  return function SourceAbstractFactory(Private, Promise, timefilter) {
    var pendingRequests = Private(require('../_pending_requests'));
    var errorHandlers = Private(require('../_error_handlers'));
    var fetch = Private(require('../fetch/fetch'));

    function SourceAbstract(initialState) {
      this._state = (function () {
        // state can be serialized as JSON, and passed back in to restore
        if (initialState) {
          if (typeof initialState === 'string') {
            return JSON.parse(initialState);
          } else {
            return _.cloneDeep(initialState);
          }
        } else {
          return {};
        }
      }());

      this._dynamicState = this._dynamicState || {};

      // get/set internal state values
      this._methods.forEach(function (name) {
        this[name] = function (val) {
          if (val == null) {
            delete this._state[name];
          } else {
            this._state[name] = val;
          }

          return this;
        };
      }, this);
    }

    /*****
     * PUBLIC API
     *****/

    /**
     * Get values from the state
     * @param {string} name - The name of the property desired
     */
    SourceAbstract.prototype.get = function (name) {
      var current = this;
      while (current) {
        if (current._state[name] !== void 0) return current._state[name];
        if (current._dynamicState[name] !== void 0) return current._dynamicState[name]();
        current = current._parent;
      }
    };

    /**
     * Change the entire state of a SourceAbstract
     * @param {object|string} state - The SourceAbstract's new state, or a
     *   string of the state value to set
     */
    SourceAbstract.prototype.set = function (state, val) {
      if (typeof state === 'string') {
        return this[state](val);
      }
      this._state = state;
      return this;
    };

    /**
     * Create a new dataSource object of the same type
     * as this, which inherits this dataSource's properties
     * @return {SourceAbstract}
     */
    SourceAbstract.prototype.extend = function () {
      return (new this.Class()).inherits(this);
    };

    /**
     * return a simple, encodable object representing the state of the SourceAbstract
     * @return {[type]} [description]
     */
    SourceAbstract.prototype.toJSON = function () {
      return _.clone(this._state);
    };

    /**
     * Create a string representation of the object
     * @return {[type]} [description]
     */
    SourceAbstract.prototype.toString = function () {
      return JSON.stringify(this.toJSON());
    };

    /**
     * Put a request in to the courier that this Source should
     * be fetched on the next run of the courier
     * @return {Promise}
     */
    SourceAbstract.prototype.onResults = function (handler) {
      var source = this;
      return new Promise.emitter(function (resolve, reject, defer) {
        pendingRequests.push({
          source: source,
          defer: defer
        });
      }, handler);
    };

    /**
     * similar to onResults, but allows a seperate loopy code path
     * for error handling.
     *
     * @return {Promise}
     */
    SourceAbstract.prototype.onError = function () {
      var defer = Promise.defer();
      errorHandlers.push({
        source: this,
        defer: defer
      });
      return defer.promise;
    };

    /**
     * Fetch just this source ASAP
     * @param {Function} cb - callback
     */
    SourceAbstract.prototype.fetch = function () {
      var source = this;
      return fetch[this._getType()](this)
      .then(function (res) {
        pendingRequests.splice(0).forEach(function (req) {
          if (req.source === source) {
            req.defer.resolve(_.cloneDeep(res));
          } else {
            pendingRequests.push(req);
          }
        });
        return res;
      });
    };

    /**
     * Cancel all pending requests for this dataSource
     * @return {undefined}
     */
    SourceAbstract.prototype.cancelPending = function () {
      var pending = _.where(pendingRequests, { source: this});
      _.pull.apply(_, [pendingRequests].concat(pending));
    };

    /**
     * Completely destroy the SearchSource.
     * @return {undefined}
     */
    SourceAbstract.prototype.destroy = function () {
      this.cancelPending();
    };

    /*****
     * PRIVATE API
     *****/

    /**
     * Walk the inheritance chain of a source and return it's
     * flat representaion (taking into account merging rules)
     * @returns {Promise}
     * @resolved {Object|null} - the flat state of the SourceAbstract
     */
    SourceAbstract.prototype._flatten = function () {
      var type = this._getType();

      // the merged state of this dataSource and it's ancestors
      var flatState = {};

      // function used to write each property from each state object in the chain to flat state
      var root = this;

      // start the chain at this source
      var current = this;

      // call the ittr and return it's promise
      return (function ittr(resolve, reject) {
        // itterate the _state object (not array) and
        // pass each key:value pair to source._mergeProp. if _mergeProp
        // returns a promise, then wait for it to complete and call _mergeProp again
        return Promise.all(_.map(current._state, function ittr(value, key) {
          if (Promise.is(value)) {
            return value.then(function (value) {
              return ittr(value, key);
            });
          }

          var prom = root._mergeProp(flatState, value, key);
          return Promise.is(prom) ? prom : null;
        }))
        .then(function () {
          // move to this sources parent
          current = current._parent;

          // keep calling until we reach the top parent
          if (current) return ittr();
        });
      }())
      .then(function () {
        if (type === 'search') {
          // defaults for the query
          if (!flatState.body.query) {
            flatState.body.query = {
              'match_all': {}
            };
          }

          // switch to filtered query if there are filters
          if (flatState.filters) {
            if (flatState.filters.length) {
              flatState.body.query = {
                filtered: {
                  query: flatState.body.query,
                  filter: {
                    bool: {
                      must: flatState.filters
                    }
                  }
                }
              };
            }
            delete flatState.filters;
          }
        }

        return flatState;
      });
    };

    return SourceAbstract;

  };
});