(function() {
  (function(root, factory) {
    if (typeof define === "function" && define.amd) {
      return define(["backbone"], factory);
    } else if (typeof exports !== "undefined" && typeof require === "function") {
      return module.exports = factory(require("backbone"));
    } else {
      return factory(Backbone);
    }
  })(this, function(Backbone) {
    var CONSOLE_TAG, eventNames, states, wrapError;
    CONSOLE_TAG = "backbone-dualStorage";
    states = {
      SYNCHRONIZED: 'SYNCHRONIZED',
      SYNCHRONIZING: 'SYNCHRONIZING',
      UPDATE_FAILED: 'UPDATE_FAILED',
      CREATE_FAILED: 'CREATE_FAILED',
      DELETE_FAILED: 'DELETE_FAILED'
    };
    eventNames = {
      LOCAL_SYNC_FAIL: 'LOCAL_SYNC_FAIL',
      LOCAL_SYNC_SUCCESS: 'LOCAL_SYNC_SUCCESS',
      REMOTE_SYNC_FAIL: 'REMOTE_SYNC_FAIL',
      REMOTE_SYNC_SUCCESS: 'REMOTE_SYNC_SUCCESS',
      SYNCHRONIZED: 'SYNCHRONIZED'
    };
    wrapError = function(model, options) {
      var error;
      error = options.error;
      return options.error = function(resp) {
        if (error) {
          error(model, resp, options);
        }
        return model.trigger('error', model, resp, options);
      };
    };
    Backbone.DualModel = Backbone.Model.extend({
      states: states,
      remoteIdAttribute: 'id',
      hasRemoteId: function() {
        return !!this.get(this.remoteIdAttribute);
      },
      getUrlForSync: function(urlRoot, method) {
        var remoteId;
        remoteId = this.get(this.remoteIdAttribute);
        if (remoteId && (method === 'update' || method === 'delete')) {
          return "" + urlRoot + "/" + remoteId + "/";
        }
        return urlRoot;
      },
      isInSynchronizing: function() {
        return this.get('status') === this.states.SYNCHRONIZING;
      },
      isDelayed: function() {
        var _ref;
        return (_ref = this.get('status')) === this.states.DELETE_FAILED || _ref === this.states.UPDATE_FAILED || _ref === this.states.CREATE_FAILED;
      }
    });
    Backbone.IndexedDB.prototype.create = function(model, options) {
      var data;
      model.set('status', states.CREATE_FAILED);
      data = model.attributes;
      return this.store.put(data, (function(_this) {
        return function(insertedId) {
          data[_this.keyPath] = insertedId;
          return options.success(data);
        };
      })(this), options.error);
    };
    Backbone.IndexedDB.prototype.update = function(model, options) {
      var data;
      if (model.hasRemoteId()) {
        model.set('status', states.UPDATE_FAILED);
      }
      data = model.attributes;
      return this.store.put(data, options.success, options.error);
    };
    Backbone.IndexedDB.prototype.getAll = function(options) {
      var data;
      data = [];
      return this.iterate(function(item) {
        if (item.status !== states.DELETE_FAILED) {
          return data.push(item);
        }
      }, {
        onEnd: function() {
          return options.success(data);
        }
      });
    };
    Backbone.IndexedDB.prototype.destroy = function(model, options) {
      var data;
      if (model.isNew()) {
        return false;
      }
      model.set('status', states.DELETE_FAILED);
      data = model.attributes;
      return this.store.put(data, options.success, options.error);
    };
    Backbone.DualCollection = Backbone.Collection.extend({
      states: states,
      eventNames: eventNames,
      getSyncMethodsByState: function(state) {
        var method;
        return method = (function() {
          switch (false) {
            case this.states.CREATE_FAILED !== state:
              return 'create';
            case this.states.UPDATE_FAILED !== state:
              return 'update';
            case this.states.DELETE_FAILED !== state:
              return 'delete';
          }
        }).call(this);
      },
      mergeFirstSync: function(newData) {
        return newData;
      },
      mergeFullSync: function(newData) {
        return newData;
      },
      firstSync: function(options) {
        var event, fetchSuccess, originalSuccess, syncError, syncSuccess;
        if (options == null) {
          options = {};
        }
        originalSuccess = options.success || $.noop;
        event = _.extend({}, Backbone.Events);
        syncSuccess = (function(_this) {
          return function(response) {
            var data, method;
            data = _this.mergeFirstSync(_this.parse(response));
            event.trigger(_this.eventNames.REMOTE_SYNC_SUCCESS);
            method = options.reset ? 'reset' : 'set';
            _this[method](data, options);
            originalSuccess(_this, data, options);
            _this.trigger('sync', _this, data, options);
            wrapError(_this, options);
            return _this.save().done(function() {
              return _this.fetch().done(function() {
                return event.trigger(_this.eventNames.SYNCHRONIZED);
              });
            });
          };
        })(this);
        syncError = (function(_this) {
          return function(error) {
            return event.trigger(_this.eventNames.REMOTE_SYNC_FAIL, error, options);
          };
        })(this);
        fetchSuccess = (function(_this) {
          return function(data) {
            options.success = syncSuccess;
            options.error = syncError;
            event.trigger(_this.eventNames.LOCAL_SYNC_SUCCESS, data);
            return Backbone.ajaxSync('read', _this, options);
          };
        })(this);
        this.fetch({
          success: fetchSuccess,
          error: function(error) {
            return event.trigger(this.eventNames.LOCAL_SYNC_FAIL, error);
          }
        });
        return event;
      },
      removeGarbage: function(delayedData) {
        var deferred, idsForRemove, key;
        deferred = new $.Deferred();
        key = this.indexedDB.keyPath;
        idsForRemove = _.map(delayedData, function(item) {
          return item[key];
        });
        this.indexedDB.removeBatch(idsForRemove, (function() {
          return deferred.resolve();
        }), (function() {
          return deferred.reject();
        }));
        return deferred.promise();
      },
      _getDelayedData: function(status) {
        var data, deferred, keyRange, options;
        deferred = new $.Deferred();
        data = [];
        keyRange = this.indexedDB.makeKeyRange({
          lower: status,
          upper: status
        });
        options = {
          index: 'status',
          keyRange: keyRange,
          onEnd: function() {
            return deferred.resolve(data);
          }
        };
        this.indexedDB.iterate(function(item) {
          return data.push(item);
        }, options);
        return deferred.promise();
      },
      getDelayedData: function() {
        var created, deferred, deleted, updated;
        deferred = new $.Deferred();
        deleted = this._getDelayedData(this.states.DELETE_FAILED);
        created = this._getDelayedData(this.states.CREATE_FAILED);
        updated = this._getDelayedData(this.states.UPDATE_FAILED);
        $.when(deleted, created, updated).done(function(a, b, c) {
          return deferred.resolve(_.union(a, b, c));
        });
        return deferred.promise();
      },
      fullSync: function() {
        var deferred;
        deferred = new $.Deferred();
        this.getDelayedData().done((function(_this) {
          return function(delayedData) {
            var count, done;
            console.log(CONSOLE_TAG, 'start full sync', delayedData);
            count = 0;
            done = function() {
              count++;
              if (count === delayedData.length) {
                return _this.fetch().done(function() {
                  return deferred.resolve();
                });
              }
            };
            return _.each(delayedData, function(item) {
              var method, model, status;
              status = item.status;
              method = _this.getSyncMethodsByState(status);
              delete item.status;
              model = new _this.model(item);
              console.log(CONSOLE_TAG, 'full sync model', item, method);
              model.url = model.getUrlForSync(_.result(_this, 'url'), method);
              return Backbone.ajaxSync(method, model, {
                success: (function(response) {
                  var data;
                  if (status === _this.states.DELETE_FAILED) {
                    return _this.removeGarbage([item]).done(done());
                  } else {
                    data = _this.mergeFullSync(_this.parse(response));
                    delete data.status;
                    _this.get(item[_this.indexedDB.keyPath]).set(data);
                    return _this.indexedDB.store.put(data, done, done);
                  }
                }),
                error: function() {
                  return deferred.reject(item);
                }
              });
            });
          };
        })(this));
        return deferred.promise();
      },
      save: function() {
        var deferred;
        deferred = new $.Deferred();
        this.indexedDB.saveAll((function() {
          return deferred.resolve();
        }), (function() {
          return deferred.reject();
        }));
        return deferred.promise();
      }
    });
    return Backbone;
  });

}).call(this);

//# sourceMappingURL=backbone.dualstorage.js.map
