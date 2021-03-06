'use strict';

var clone = require('lodash.clone');
var types = require('./types');
var queryize = require('queryize');
var proxmis = require('proxmis');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

/**
 * Creates a Model constructor, using provided the tablename and/or prototype, for
 * creating records representing rows in the table.
 * All properties of the options object will be mixed into to the model's prototype.
 *
 * @name  quell
 * @typedef quell
 * @constructor
 * @param  {string} [tablename]
 * @param  {object} [options]
 * @return {Model}
 * @example
 * // Create a plain model for the users table that loads its schema
 * // from the database on first use.
 *
 * var User = quell('users');
 * @example
 * // Alternative syntax for defining the table name, with a prototype method.
 *
 * var User = quell({
 *   tablename: 'users',
 *
 *   checkPassword: function (password) {
 *     // ...
 *   }
 * });
 * @example
 * // Create a model for the user table with a predefined expected schema and
 * // couple member functions. Quell will not attempt to fetch the table schema
 * // if a valid definition exists on the prototype.
 *
 * var User = quell('users', {
 *   schema: {
 *     columns: {
 *       id:       quell.INT({unsigned: true}),
 *       email:    quell.VARCHAR(255)
 *       fullname: quell.TINYTEXT(),
 *       enabled:  quell.BOOLEAN()
 *     },
 *     autoincrement: 'id',
 *     primaries: ['id']
 *   },
 *
 *   enable: function () {
 *     this.set('enabled', true);
 *     return this;
 *   },
 *
 *   disable: function () {
 *     this.set('enabled', false);
 *     return this;
 *   }
 * });
 */
var quell = function (tablename, options) {

	if (typeof tablename === 'object') {
		options = tablename;
	} else {
		options = options || {};
		options.tablename = tablename;
	}

	if (!options.tablename || typeof options.tablename !== 'string') { throw new TypeError('Tablename must be a string.'); }

	var model = function () {
		if (!this.connection) {
			this.connection = model.prototype.connection || options.connection || quell.connection || false;
		}
		modelBase.apply(this, arguments);
	};

	// Copy over the Model members
	Object.assign(model, modelBase);

	// Create the new Model prototype
	model.prototype = Object.create(modelBase.prototype);

	// Apply any overrides
	Object.assign(model.prototype, options);

	model.prototype.tablename = model.tablename = options.tablename;
	model.connection = model.prototype.connection = options.connection || quell.connection || false;

	return model;
};

Object.assign(quell, types);

module.exports = exports = quell;

/**
 * Model constructor used to create a new record.
 * Takes the default data contents of the model.
 *
 * @example
 *
 * var User = quell('users')
 * var userRecord = new User();
 *
 * @name Model
 * @typedef Model
 * @constructor
 * @param  {object} [data]
 * @param  {object} [options]
 * @return {Record}
 */
function modelBase (data, options) {
	data = data || {};
	options = options || {};

	if (options.connection) {
		this.connection = options.connection;
	} else if (quell.connection) {
		this.connection = quell.connection;
	}

	this.data = {};
	this.set(data, options);
	this.changed = {};

	EventEmitter.call(this);
	this.initialize.apply(this, arguments);
};

quell._model = modelBase;

util.inherits(modelBase, EventEmitter);


/**
 * @name Record
 * @typedef Record
 * @type {Object}
 */
var Record = {
	/**
	 * The raw model data.
	 *
	 * @memberOf Record
	 * @internal Not intended for direct access.  Use Record.get() and Record.set() instead.
	 * @type {object}
	 */
	data: null,

	/**
	 * Indicates if the record already exists in the database.  Will be null if existence is unknown.
	 *
	 * @memberOf Record
	 * @type {boolean}
	 */
	exists: null,

	/**
	 * Function called at model initialization. Abstract method intended to be overridden during
	 * model creation, not intended to be called directly.
	 *
	 * Receives all arguments passed to `new Model()`.
	 *
	 * @memberOf Record
	 * @abstract
	 * @example
	 * var User = quell({
	 *   initialize: function (data, options) {
	 *     console.log('User record instance created', data);
	 *   }
	 * });
	 *
	 * var user = new User({id: 200});
	 * // Console:
	 * // "User record instance created", {"id": 200}
	 */
	initialize () {
		// override me
	},

	/**
	 * Returns a copy of the model's data
	 * @return {Object}
	 */
	toJSON () {
		return clone(this.data);
	},

	/**
	 * Gets the current value of a column from the Record.
	 *
	 * @memberOf Record
	 * @param  {string} field The column to retrieve.
	 * @param  {boolean} [formatted] Indicates if the data should be returned in the format
	 * MySQL would store it in. Defaults to true.
	 * @return {mixed}
	 */
	get (field, formatted) {
		// default to formatted unless the user passed false
		if ((formatted || formatted === undefined) && this.schema && this.schema.columns && this.schema.columns[field]) {
			return this.schema.columns[field].format(this.data[field]);
		}

		return this.data[field];
	},

	/**
	 * Set a hash of attributes (one or many) on the model.
	 *
	 * If any of the attributes change the model's state, a "change" event will be triggered
	 * on the model. Change events for specific attributes are also triggered, and you can bind
	 * to those as well, for example: change:title, and change:content. You may also pass
	 * individual keys and values.
	 *
	 * @memberOf Record
	 * @param {string|object} field
	 * @param {mixed} [value]
	 * @param {object} [options]
	 */
	set (field, value, options) {
		if (!field) {
			return this;
		}

		// Handle both `"field", value` and `{field: value}` -style arguments.
		var attrs;
		if (typeof field === 'object') {
			attrs = field;
			options = value;
		} else {
			(attrs = {})[field] = value;
		}

		options = options || {};

		// Extract data and options.
		var unset           = options.unset;
		var silent          = options.silent;
		var changes         = [];
		var changing        = this._changing;
		this._changing  = true;

		if (!changing) {
			this._previousData = clone(this.data);
			this.changed = {};
		}
		var current = this.data;
		var prev = this._previousData;

		// For each `set` data, update or delete the current value.
		Object.keys(attrs).forEach((attr) => {
			var attrValue = attrs[attr];
			if (!isEqual(current[attr], attrValue, this.schema && this.schema[attr])) {
				changes.push(attr);
			}
			if (!isEqual(prev[attr], attrValue, this.schema && this.schema[attr])) {
				this.changed[attr] = attrValue;
			} else {
				delete this.changed[attr];
			}
			if (unset) {
				delete current[attr];
			} else {
				current[attr] = attrValue;
			}
		});

		// Trigger all relevant data changes.
		if (!silent) {
			if (changes.length) { this._pending = true; }
			for (var i = 0, l = changes.length; i < l; i++) {
				this.emit('change:' + changes[i], this, current[changes[i]], options);
			}
		}

		// You might be wondering why there's a `while` loop here. Changes can
		// be recursively nested within `"change"` events.
		if (changing) { return this; }
		if (!silent) {
			while (this._pending) {
				this._pending = false;
				this.emit('change', this, options);
			}
		}
		this._pending = false;
		this._changing = false;
		return this;
	},

	/**
	 * Remove an attribute by deleting it from the internal attributes hash.
	 *
	 * Fires a "change" event unless silent is passed as an option.
	 * @memberOf Record
	 * @param  {string} field
	 * @param  {object} [options]
	 */
	unset (field, options) {
		return this.set(field, undefined, Object.assign({}, options, { unset: true }));
	},

	/**
	 * Returns `true` if the attribute is set to a non-null or non-undefined value.
	 *
	 * @memberOf Record
	 * @param  {string}  field
	 * @return {Boolean}
	 */
	has (field) {
		return Boolean(typeof this.data[field] !== 'undefined');
	},

	/**
	 * Fetches a record from the database.
	 *
	 * Load may be called in a variety of ways depending on the object state. The following are all
	 * methods that may be used to load a record from a table primary keyed on an 'id' column.
	 * Returns an ES6 Promise, but a traditional callback may be supplied as the last argument instead.
	 * If the response is false, a record could not be found matching the keys requested.
	 *
	 * If no schema is defined on the model, Quell will load the schema from the database before
	 * performing the select.
	 *
	 * @example
	 * // Load using existing data already in the record object.
	 * var record = new User({id: 16});
	 * record.load().then(function (exists) {
	 *   // loaded.
	 * });
	 *
	 * @example
	 * // Load using primary key (note, does not work for tables with multiple primaries)
	 * var record = new User();
	 * record.load(16).then(function (exists) {
	 *   // loaded
	 * });
	 *
	 * @example
	 * // Load using a specific column value (column does not need to be a primary key)
	 * var record = new User();
	 * record.load(16, 'id', function (exists) {
	 *   // loaded
	 * });
	 *
	 * @example
	 * // Load using multiple column values, or a column hash.
	 * var record = new User();
	 * record.load({id: 16}, function (exists) {
	 *   // loaded
	 * });
	 *
	 * @memberOf Record
	 * @param  {mixed}    [value]
	 * @param  {string}   [field]
	 * @param  {object}   [options]
	 * @param  {Function} [callback] Callback to be executed when the record is loaded.
	 * @return {Promise}
	 */
	load (value, field, options, callback) {
		switch (arguments.length) {
		case 3:
			if (typeof options === 'function') {
				callback = options;
				options = { callback };
			} else {
				options = options || {};
				options.callback = options.callback || callback;
			}
			break;
		case 2:
			if (typeof field === 'function') {
				callback = field;
				field = undefined;
			}
			if (typeof field === 'object') {
				options = field || {};
				field = undefined;
			}
			break;
		case 1:
			if (typeof value === 'function') {
				callback = value;
				value = undefined;
			}
			break;
		default:
			break;
		}

		var defer;
		if (value === undefined) {
			defer = this._loadWithExisting(options);
		} else if (typeof value === 'object') {
			defer = this._loadWithMultiColumn(value, options);
		} else if (isScalar(value)) {
			if (field === undefined) {
				defer = this._loadWithPrimaryKey(value, options);
			} else {
				defer = this._loadWithSingleColumn(value, field, options);
			}
		}

		if (typeof callback === 'function') {
			return defer.then(
				(exists) => { callback(null, exists); },
				(err) => { callback(err || true); }
			);
		}

		return defer;
	},

	/**
	 * Intelligently saves the record contents to the database.
	 *
	 * `Record.save()` attempts to ascertain if the record already exists in the database
	 * by performing a query for the primary keys. This query is skipped if it is already known
	 * if the record exists due to a fetch or `Record.exists` being set to `true` or `false`.
	 *
	 * If the record exists, an update is performed, otherwise a fresh insert is done.
	 * If the options object contains a truthy `replace` option, the save will always be a REPLACE.
	 *
	 * See `Record.update` and `Record.insert` for details of those behaviors.
	 *
	 * Returns an ES6 Promise, but a traditional callback may be supplied as the last argument instead.
	 *
	 * @memberOf Record
	 * @param  {object}   [options]
	 * @param  {Function} [callback]
	 * @return {Promise}
	 */
	save (options, callback) {
		var self = this;

		if (typeof options === 'function') {
			callback = options;
			options = { callback };
		} else {
			options = options || {};
			options.callback = options.callback || callback;
		}

		if (options.replace) {
			var ai = this.schema && this.schema.autoincrement;
			if (ai) {
				this.unset(ai);
			}

			return this.insert(options);

		}

		return Promise.resolve(self.exists === null ? self._promiseIfExists(options) : self.exists)
			.then((exists) => {
				if (exists) {
					return self.update(options, callback);
				}

				return self.insert(options, callback);
			});
	},

	/**
	 * Inserts the record into the database as a new row.
	 *
	 * If the table has an auto-incrementing id, that field on the record will be updated to the new id,
	 * overwriting any existing value.
	 *
	 * If the options object contains a truthy `replace` option, the save will always be a REPLACE using
	 * the existing primary keys (including an auto-incrementing key).
	 *
	 * Returns an ES6 Promise, but a traditional callback may be supplied as the last argument instead.
	 *
	 * If no schema is defined on the model, Quell will load the schema from the database before
	 * performing the insert.

	 * @memberOf Record
	 * @param  {object}   [options]
	 * @param  {Function} [callback]
	 * @return {Promise}
	 */
	insert (options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = { callback };
		} else {
			options = options || {};
			options.callback = options.callback || callback;
		}

		var self = this;
		return this._promiseValidateSchema()
			.then(() => {
				var write = {};
				var	fields = Object.keys(self.data);

				for (let i = 0; i < fields.length; i++) {
					const field = fields[i];
					const type = self.schema.columns[field];

					if (type && typeof self.data[field] !== 'undefined' && (options.replace || self.schema.autoincrement !== field)) {
						write[field] = type.prepare(self.data[field]);
					}
				}

				return quell._buildInsertQuery(self.tablename, write, options.replace);
			})
			.then((query) => quell._promiseQueryRun(
				query.query,
				query.data,
				(options && options.connection) || self.connection || quell.connection
			))
			.then((result) => {
				if (self.schema.autoincrement && result && result.insertId !== undefined) {
					self.data[self.schema.autoincrement] = result.insertId;
				}

				if (options.callback) {
					options.callback(null, self);
				}

				return self;
			}).catch((err) => {
				if (options.callback) {
					callback(err);
				}

				return Promise.reject(err);
			});
	},

	/**
	 * Updates the database with the current contents of the record.
	 *
	 * By default the update operation uses the primary keys of the record as the `WHERE` clause of the
	 * `UPDATE` query, and will throw an error if all of the primary keys do not contain values.  This
	 * behavior can be overridden by providing a `using` hash object in the update options which defines
	 * what column values to use for the update. This is the only way to perform an update if the table
	 * schema does not define any primary keys.
	 *
	 * Returns an ES6 Promise, but a traditional callback may be supplied as the last argument instead.
	 *
	 * If no schema is defined on the model, Quell will load the schema from the database before
	 * performing the update.
	 *
	 * @memberOf Record
	 * @param  {object}   [options]
	 * @param  {Function} [callback]
	 * @return {Promise}
	 */
	update (options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = { callback };
		} else {
			options = options || {};
			options.callback = options.callback || callback;
		}

		var self = this;
		return this._promiseValidateSchema()
			.then(() => {
				var lookup = {};
				var lookupCount = 0;
				var write = {};
				var fields = Object.keys(self.data);

				if (typeof options.using === 'object') {
					lookup = options.using;
					lookupCount = Object.keys(lookup).length;
				} else {

					for (let i = 0; i < self.schema.primaries.length; i++) {
						const field = self.schema.primaries[i];
						const type = self.schema.columns[field];

						if (!self.has(field)) {
							throw new Error('Could not update quell record, required primary key value was absent: ' + field);
						} else {
							lookup[field] = type.prepare(self.data[field]);
							lookupCount++;
						}
					}

				}

				if (!lookupCount) {
					throw new Error('Could not update quell record, no primary keys was available to update against.');
				}

				for (let i = 0; i < fields.length; i++) {
					const field = fields[i];
					const type = self.schema.columns[field];

					if (type && typeof self.data[field] !== 'undefined' && (options.replace || self.schema.autoincrement !== field)) {
						write[field] = type.prepare(self.data[field]);
					}
				}

				return quell._buildUpdateQuery(self.tablename, write, lookup);
			})
			.then((query) => quell._promiseQueryRun(
				query.query,
				query.data,
				(options && options.connection) || self.connection || quell.connection
			))
			.then(() => {
				if (options.callback) {
					options.callback(null, self);
				}

				return self;
			}).catch((err) => {
				if (options.callback) {
					callback(err);
				}

				return Promise.reject(err);
			});
	},

	/**
	 * Deletes the record from the database.
	 *
	 * By default the delete operation uses the primary keys of the record as the `WHERE` clause of the
	 * `DELETE` query, and will throw an error if all of the primary keys do not contain values.  If the
	 * table schema does not define any primary keys, Quell will use all data on the record to conduct the
	 * query.  This behavior can be overridden by providing a `using` hash object in the delete options
	 * which defines what column values to use for the delete. An error will be thrown if no values exist
	 * to perform the delete with, so as to avoid deleting everything.
	 *
	 * Returns an ES6 Promise, but a traditional callback may be supplied as the last argument instead.
	 *
	 * If no schema is defined on the model, Quell will load the schema from the database before
	 * performing the delete.
	 *
	 * @memberOf Record
	 * @param  {object}   [options]
	 * @param  {Function} [callback]
	 * @return {Promise}
	 */
	delete (options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = { callback };
		} else {
			options = options || {};
			options.callback = options.callback || callback;
		}

		var self = this;
		return this._promiseValidateSchema()
			.then(() => {
				var lookup = {};
				var lookupCount = 0;
				var fields = self.schema.primaries;

				if (typeof options.using === 'object') {
					lookup = options.using;
					lookupCount = Object.keys(lookup).length;
					// If the schema has no primary keys, use any column data we have.
				} else if (fields.length) {
					for (let i = 0; i < fields.length; i++) {
						const field = fields[i];
						const type = self.schema.columns[field];

						if (!self.has(field)) {
							throw new Error('Could not delete quell record, required primary key value was absent: ' + field);
						} else {
							lookup[field] = type.prepare(self.data[field]);
							lookupCount++;
						}
					}
				} else {
					fields = Object.keys(self.schema.columns);

					for (let i = 0; i < fields.length; i++) {
						const field = fields[i];
						const type = self.schema.columns[field];

						if (self.has(field)) {
							lookup[field] = type.prepare(self.data[field]);
							lookupCount++;
						}
					}
				}

				if (!lookupCount) {
					throw new Error('Could not delete quell record, no data was available to delete against.');
				}


				return quell._buildDeleteQuery(self.tablename, lookup);
			})
			.then((query) => quell._promiseQueryRun(
				query.query,
				query.data,
				(options && options.connection) || self.connection || quell.connection
			))
			.then(() => {
				self.exists = false;

				if (options.callback) {
					options.callback(null, self);
				}

				return self;
			}).catch((err) => {
				if (options.callback) {
					callback(err);
				}

				return Promise.reject(err);
			});
	},


	/**
	 * Loads a record from the database using the existing primary key data.
	 * @private
	 * @memberOf Record
	 * @return {Promise}
	 */
	_loadWithExisting (options) {
		var self = this;
		return this._promiseValidateSchema().then(() => {
			if (!self.schema.primaries || !self.schema.primaries.length) {
				throw new Error('Could not load quell model using existing data; table has no primary keys.');
			}

			var lookup = {};

			for (let i = 0; i < self.schema.primaries.length; i++) {
				const field = self.schema.primaries[i];
				const type = self.schema.columns[field];

				if (!self.has(field)) {
					throw new Error('Could not load quell record, required primary key value was absent: ' + field);
				} else {
					lookup[field] = type.prepare(self.data[field]);
				}
			}

			return self._loadUsing(lookup, options);
		});
	},

	/**
	 * Loads a record from the database using a single primary key.
	 *
	 * @private
	 * @memberOf Record
	 * @param  {mixed} value
	 * @return {Promise}
	 */
	_loadWithPrimaryKey (value, options) {
		var self = this;
		return this._promiseValidateSchema().then(() => {
			if (!self.schema.primaries.length) {
				throw new Error('Could not load quell model using existing data; schema has no primary keys.');
			}

			if (self.schema.primaries.length > 1) {
				throw new Error('Could not load quell model using single primary key, schema has more than one primary key.');
			}

			var key = self.schema.primaries[0];
			var type = self.schema.columns[key];
			var lookup = {};

			lookup[key] = type.prepare(value);

			return self._loadUsing(lookup, options);
		});
	},

	/**
	 * Loads a record from the database using a single column value.
	 *
	 * @private
	 * @memberOf Record
	 * @param  {mixed} value
	 * @param  {string} field
	 * @return {Promise}
	 */
	_loadWithSingleColumn (value, field, options) {
		var self = this;
		return this._promiseValidateSchema().then(() => {
			var type = self.schema.columns[field];
			var lookup = {};

			if (!type) {
				throw new Error('Could not load quell model, ' + field + ' does not exist in the table schema.');
			}

			lookup[field] = type.prepare(value);

			return self._loadUsing(lookup, options);
		});
	},

	/**
	 * Loads a record from the database using one or more column values from an object hash.
	 *
	 * @private
	 * @memberOf Record
	 * @param  {object} search
	 * @return {Promise}
	 */
	_loadWithMultiColumn (search, options) {
		return this._promiseValidateSchema().then(() => {
			if (typeof search !== 'object' || !Object.keys(search).length) {
				throw new Error('Could not load quell model; provided data was empty or not an object.');
			}

			var lookup = {};
			var fields = Object.keys(search);

			for (let i = 0; i < fields.length; i++) {
				const field = fields[i];
				const type = this.schema.columns[field];

				if (!type) {
					throw new Error('Could not load quell model, ' + field + ' does not exist in the table schema.');
				} else {
					lookup[field] = type.prepare(search[field]);
				}
			}

			return this._loadUsing(lookup, options);
		});
	},

	/**
	 * Loads a record from the database using pre-validated data.
	 * @private
	 * @memberOf Record
	 * @param  {object} lookup
	 * @return {boolean|self}
	 */
	_loadUsing (lookup, options) {
		var self = this;
		var query = quell._buildSelectQuery(self.tablename, lookup);

		return quell._promiseQueryRun(
			query.query,
			query.data,
			(options && options.connection) || self.connection || quell.connection
		).then((results) => {
			// If results are returned, then we found the row and can map the data onto the model
			// If no results were returned, then the row wasn't found and we resolve with false.
			if (results.length) {
				self.exists = true;
				self.set(results[0]);
				self.changed = {};
				return self;
			}

			self.exists = false;
			return false;
		});
	},

	/**
	 * Checks to see if the record already exists in the database using the primary keys.
	 *
	 * @private
	 * @memberOf Record
	 * @return {Promise}
	 */
	_promiseIfExists (options) {
		var self = this;
		return this._promiseValidateSchema().then(() => {
			var lookup = {};

			// if there are no primary keys, then it is impossible to determine if this row existed
			// in a previous state. Therefore, we return true if we already knew it existed before
			// or false if the previous state is unknown.  This means that all new models without
			// primary keys will default to inserts.
			if (!self.schema.primaries.length) {
				return (!!self.exists);
			}

			// Iterate over all primary keys. If we do not have a value for a key, assume the
			// record does not exist. If all keys have values, perform a lookup of those fields
			// and values to verify that the row exists.
			for (let i = 0; i < self.schema.primaries.length; i++) {
				const key = self.schema.primaries[i];
				if (!self.has(key)) {
					return (self.exists = false);
				} else if (self.schema.columns[key]) {
					lookup[key] = self.schema.columns[key].prepare(self.data[key]);
				}
			}

			var query = quell._buildSelectQuery(self.tablename, lookup, self.schema.primaries);

			return quell._promiseQueryRun(
				query.query,
				query.data,
				(options && options.connection) || self.connection || quell.connection
			).then((results) => {
				self.exists = !!results.length;
				return self.exists;
			});

		});
	},

	/**
	 * Validates the schema data for the model, loading the schema from the database if needed.
	 *
	 * @private
	 * @memberOf Record
	 * @return {Promise}
	 */
	_promiseValidateSchema () {
		var self = this;

		if (!this.connection) {
			throw new Error('quell model does not have a MySQL connection or pool defined.');
		}

		// if we have a schema already marked as good, just continue the callback chain
		if (this.schema && this.schema.loaded) {
			return Promise.resolve();
		}

		var valid =
			this.schema &&
			this.schema.primaries &&
			Array.isArray(this.schema.primaries) &&
			this.schema.columns &&
			Object.keys(this.schema.columns).length
		;

		if (!valid) {
			return quell._promiseTableSchema(this.tablename, this.connection).then((schema) => {
				self.schema = schema;
			});
		}

		return Promise.resolve();
	},
};

Object.assign(modelBase.prototype, Record);

/**
 * Constructs the query for a SELECT request.
 * @private
 * @memberOf quell
 * @param  {string} tablename
 * @param  {object} lookup
 * @param  {array} [select]
 * @return {object}
 */
quell._buildSelectQuery = function (tablename, lookup, select) {
	var q = queryize()
		.select(select || '*')
		.from(tablename)
		.where(lookup);

	return q.compile();
};

/**
 * Constructs the query for an INSERT request.
 * @private
 * @memberOf quell
 * @param  {string} tablename
 * @param  {object} write
 * @param  {boolean} [replace]
 * @return {object}
 */
quell._buildInsertQuery = function (tablename, write, replace) {
	var q = queryize()[replace ? 'replace' : 'insert'](write)
		.into(tablename);

	return q.compile();
};

/**
 * Constructs the query for an UPDATE request.
 * @private
 * @memberOf quell
 * @param  {string} tablename
 * @param  {object} write
 * @param  {object} lookup
 * @return {object}
 */
quell._buildUpdateQuery = function (tablename, write, lookup) {
	var q = queryize()
		.update(tablename)
		.set(write)
		.where(lookup);

	return q.compile();
};

/**
 * Constructs the query for a DELETE request.
 * @private
 * @memberOf quell
 * @param  {string} tablename
 * @param  {object} lookup
 * @return {object}
 */
quell._buildDeleteQuery = function (tablename, lookup) {
	var q = queryize()
		.deleteFrom(tablename)
		.where(lookup);

	return q.compile();
};

/**
 * Runs an arbitrary query.  Attempts to use prepared statements when available.
 * @private
 * @memberOf quell
 * @param  {string} query
 * @param  {array} data
 * @param  {object} mysql
 * @return {Promise}
 */
quell._promiseQueryRun = function (query, data, mysql) {
	var callback = proxmis();
	mysql.query(query, data, callback);
	return callback;
};


/**
 * Loads the schema for a table from the database and parses for use.
 * @private
 * @memberOf quell
 * @param  {string} tablename
 * @param  {object} mysql
 * @return {Promise}
 */
quell._promiseTableSchema = function (tablename, mysql) {

	return this._promiseQueryRun('DESCRIBE ' + tablename, null, mysql).then((results) => {
		var schema = {
			columns: {},
			primaries: [],
			autoincrement: false,
			loaded: true,
		};

		for (let i = 0; i < results.length; i++) {
			parseRow(results[i]);
		}

		function parseRow (row) {
			var matches;
			var column = {
				NULL: row.Null === 'YES',
			};

			if (row.Type === 'date' || row.Type === 'datetime' || row.Type === 'timestamp' || row.Type === 'time' || row.Type === 'year') {
				column = types[row.Type.toUpperCase()](column);

			} else if ((matches = row.Type.match(/^(decimal|float|double)\((\d+),(\d+)\)/))) {
				column.size = parseInt(matches[2], 10);
				column.precision = parseInt(matches[3], 10);
				column.unsigned = row.Type.indexOf('unsigned') >= 0;
				column = types[matches[1].toUpperCase()](column);

			} else if ((matches = row.Type.match(/^((?:big|medium|small|tiny)?int(?:eger)?)\((\d+)\)/))) {
				column.size = parseInt(matches[2], 10);
				column.unsigned = row.Type.indexOf('unsigned') >= 0;
				column = types[matches[1].toUpperCase()](column);

			} else if ((matches = row.Type.match(/^enum\((.*)\)/))) {
				column.options = matches[1].split(',').map((opt) => opt.slice(1, -1));
				column = types.ENUM(column);

			} else if ((matches = row.Type.match(/^((?:var)?char)\((\d+)\)/))) {
				column.size = parseInt(matches[2], 10);
				column = types[matches[1].toUpperCase()](column);

			} else {
				// didn't find a known type. Split the type field by opening
				// parens to get the type name without other info.
				column.type = row.Type.split('(')[0].toUpperCase();
				if (types[column.type]) {
					column = types[column.type](column);
				} else {
					column = types.UNKNOWN(column);
				}
			}

			schema.columns[row.Field] = column;

			if (row.Key === 'PRI') {
				schema.primaries.push(row.Field);
			}

			if (row.Extra === 'auto_increment') {
				schema.autoincrement = row.Field;
			}
		}

		return schema;
	});
};

/**
 * Creates a Queryize chain for loading multiple records.
 *
 * Overrides the `exec` function to pre-wrap all results with Quell models.
 *
 * See QueryizeJS documentation for more details.
 *
 * @memberOf Model
 * @param  {object} [where] An object hash of all columns to search against. Shortcut to calling .find().where()
 * @return {Queryize}
 */
modelBase.find = function (where) {
	var self = this;
	var q = queryize().select().from(this.tablename);
	if (where) {
		q.where(where);
	}

	var exec = q.exec;
	q.exec = function (conn, callback) {
		switch (arguments.length) {
		case 0:
			conn = self.connection || quell.connection;
			break;
		case 1:
			if (typeof conn === 'function') {
				callback = conn;
				conn = self.connection || quell.connection || undefined;
			}
			break;
		case 2:
		default:
		}

		if (!conn) {
			const err = new Error('You must provide a node-mysql connection or pool for this query to use.');
			if (callback) {
				callback(err);
			}
			return Promise.reject(err);
		}

		var defer = proxmis(callback);
		exec.call(q, conn, (err, results) => {
			if (err) return defer(err);

			results = results.map((row) => new self(row)); // eslint-disable-line new-cap

			defer(null, results);
		});

		return defer.promise;
	};

	return q;
};

/**
 * Pre-loads the schema details for the model.
 * @memberOf Model
 * @param  {object}   [options]
 * @param  {Function} [callback]
 * @return {Promise}
 */
modelBase.loadSchema = function (options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = { callback };
	} else {
		options = options || {};
		options.callback = options.callback || callback;
	}

	var self = this;
	return quell._promiseTableSchema(
		this.tablename,
		(options && options.connection) || self.connection || quell.connection
	).then((schema) => {
		self.schema = schema;
		if (options.callback) {
			callback(null, self);
		}
		return self;
	}, (err) => {
		if (callback) {
			callback(err);
		}
		return Promise.reject(err);
	});
};

/** Utility Functions *******************************************************************************************/

/**
 * Checks if the value passed in is a primitive value.
 * @private
 * @param  {mixed}  value
 * @return {Boolean}
 */
function isScalar (value) {
	switch (typeof value) {
	case 'string':
	case 'number':
	case 'boolean':
		return true;
	default:
		return false;
	}
}

/**
 * Checks if two values are equal using the column type
 * @private
 * @param  {mixed}  a
 * @param  {mixed}  b
 * @param  {function} [ctype]
 * @return {Boolean}
 */
function isEqual (a, b, ctype) {
	if (ctype) {
		return ctype.compare(a, b);
	}

	if (a === b) { return true; }

	return false;
}

