
var suite = require('tapsuite');
var test = require('tap').test;
var quell = require('../');

function logError (err) {
	var error = {
		error: Object.assign({
			message: err.message,
			stack: (err.stack || '').split('\n').slice(1).map((v) => '' + v + ''),
		}, err),
	};
	console.log(error);
}

var mockConnection = function (test, expectedQuery, expectedData, returnValue) {
	return {
		query (query, data, callback) {
			if (expectedQuery !== undefined) { test.strictEqual(query, expectedQuery); }
			if (expectedData !== undefined) { test.deepEqual(data, expectedData); }
			test.ok(true, 'Mysql query was called');
			callback(null, returnValue);
		},
	};
};

test('model.find with promise and connection', (test) => {
	var Model = quell('users');
	var con = mockConnection(test, 'SELECT * FROM `users` WHERE id = ?', [ 1 ], [ { id: 1, name: 'john doe' } ]);

	test.plan(5);
	Model.find({ id: 1 }).exec(con).then((actual) => {
		test.deepEqual(actual[0].data, { id: 1, name: 'john doe' });
		test.ok(true);
		test.end();
	}, (err) => {
		console.error(err);
		test.ok(false, 'Promise rejected');
		test.end();
	});

});

test('model.find with promise and implicit connection', (test) => {
	var Model = quell('users');
	var con = mockConnection(test, 'SELECT * FROM `users` WHERE id = ?', [ 1 ], [ { id: 1, name: 'john doe' } ]);

	test.plan(5);
	Model.connection = con;
	Model.find({ id: 1 }).exec().then((actual) => {
		test.deepEqual(actual[0].data, { id: 1, name: 'john doe' });
		test.ok(true);
		test.end();
	}, (err) => {
		console.error(err);
		test.ok(false, 'Promise rejected');
		test.end();
	});

});

test('model.find with promise and no connection', (test) => {
	var Model = quell('users');

	test.plan(1);
	test.throws(() => {
		Model.find({ id: 1 }).exec();
	});

	test.end();
});

test('model.find with callback and connection', (test) => {
	var Model = quell('users');
	var con = mockConnection(test, 'SELECT * FROM `users` WHERE id = ?', [ 1 ], [ { id: 1, name: 'john doe' } ]);

	test.plan(6);
	Model.find({ id: 1 }).exec(con, (err, actual) => {
		test.equal(err, null);
		test.deepEqual(actual[0].data, { id: 1, name: 'john doe' });
		test.ok(true);
		test.end();
	});

});

test('model.find with callback and implicit connection', (test) => {
	var Model = quell('users');
	var con = mockConnection(test, 'SELECT * FROM `users` WHERE id = ?', [ 1 ], [ { id: 1, name: 'john doe' } ]);

	test.plan(6);
	Model.connection = con;
	Model.find({ id: 1 }).exec((err, actual) => {
		test.equal(err, null);
		test.deepEqual(actual[0].data, { id: 1, name: 'john doe' });
		test.ok(true);
		test.end();
	});

});


suite('model.loadSchema', (t) => {

	t.before((done) => {
		this._promiseTableSchemaBackup = quell._promiseTableSchema;
		done();
	});


	t.after((done) => {
		quell._promiseTableSchema = this._promiseTableSchemaBackup;
		done();
	});

	t.test('using promise', (test) => {

		var mockConnection = {
			query () {
				test.ok(false, 'Query should not have been called');
			},
		};

		var mockSchema = {
			columns: {
				id: quell.INT(),
				name: quell.VARCHAR(),
			},
			primaries: [ 'id' ],
			autoincrement: 'id',
		};

		quell._promiseTableSchema = function () {
			return Promise.resolve(mockSchema);
		};

		var Model = quell('users', {
			connection: mockConnection,
		});

		Model.loadSchema().then((result) => {
			test.equal(result, Model);
			test.deepEqual(Model.schema, mockSchema);
			test.ok(true, 'promise resolved');
			test.end();
		}, (err) => {
			logError(err);
			test.ok(false, 'promise rejected');
			test.end();
		});
	});
});
