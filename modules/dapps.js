var constants = require("../helpers/constants.js"),
	RequestSanitizer = require('../helpers/request-sanitizer'),
	async = require("async"),
	fs = require('fs'),
	path = require('path'),
	git = require('gift'),
	TransactionTypes = require('../helpers/transaction-types.js'),
	crypto = require('crypto'),
	bignum = require('bignum'),
	ed = require('ed25519'),
	Router = require('../helpers/router.js'),
	npm = require('npm'),
	Sandbox = require('codius-node-sandbox'),
	jayson = require('jayson');

var modules, library, self, private = {};

private.unconfirmedNames = {};
private.unconfirmedLinks = {};
private.appPath = process.cwd();
private.sandboxes = {};
private.clients = {};
private.routes = {};


private.createBasePath = function () {
	var dAppPath = path.join(private.appPath, "dapps");

	if (!fs.existsSync(dAppPath)) {
		fs.mkdirSync(dAppPath);
	}
}

private.installDApp = function (dApp, cb) {
	var id = dApp.id;

	library.logger.info("Installing " + id + " DApp");

	var dAppPath = path.join(private.appPath, "dapps", id);

	if (fs.existsSync(dAppPath)) {
		return setImmediate(cb, "This DApp already installed");
	}

	git.clone(dApp.git, dAppPath, function (err, repo) {
		if (err) {
			library.logger.error(err.toString());
			setImmediate(cb, "Git error of cloning repository " + dApp.git + " , " + id);
		} else {
			var packageJson = path.join(dAppPath, "package.json");
			var config = null;

			try {
				config = JSON.parse(fs.readFileSync(packageJson));
			} catch (e) {
				return setImmediate(cb, "Incorrect package.json file for " + id + " DApp");
			}

			npm.load(config, function (err) {
				if (err) {
					library.logger.error(err.toString());
					setImmediate(cb, "Can't read package.json of " + id + " DApp");
				} else {
					npm.root = path.join(dAppPath, "node_modules");
					npm.prefix = dAppPath;

					npm.commands.install(function (err, data) {
						if (err) {
							library.logger.error(err.toString());
							setImmediate(cb, "Can't install dependencies of " + id + " DApp");
						} else {
							library.logger.info("DApp " + id + " succesfull installed");
							setImmediate(cb, null, dAppPath);
						}
					});

					npm.on("log", function (message) {
						library.logger.info(message);
					});
				}
			});
		}
	});
}

private.initializeDAppRoutes = function (id, routes, cb) {
	private.routes[id] = new Router();

	if (typeof routes != "object" || !routes.length) {
		return cb("Invalid routes object");
	}

	console.log(routes);
	routes.forEach(function (router) {
		if (router.method == "get") {
			private.routes[id].get(router.path, function (req, res) {
				var body = req.query;
				private.clients[id].request('api', [router.path, 'get', body], function (err, error, resp) {
					if (err || error) {
						return res.json({success: false, error: err || error});
					} else if (typeof resp == "object") {
						return res.json(resp);
					} else {
						return res.json({success: false, error: "Incorrect response from api call"});
					}
				});
			});
		}
	});

	library.network.app.use('/api/dapps/' + id + '/', private.routes[id]);
	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});

	return cb();
}

private.launchDApp = function (dApp, cb) {
	var id = dApp.id;

	if (private.sandboxes[id]) {
		return setImmediate(cb, "This dapp already launched");
	}

	library.logger.info("Launching " + id + " DApp");

	var dAppPath = path.join(private.appPath, "dapps", id);

	if (!fs.existsSync(dAppPath)) {
		return setImmediate(cb, "This DApp not installed");
	}

	var dAppConfig = null;

	try {
		dAppConfig = require(path.join(dAppPath, "config.json"));
	} catch (e) {
		return setImmedaite(cb, "This DApp don't have config file, can't launch it");
	}

	function apiHandler(message, callback) {
		var args;
		if (typeof message.data === 'string') {
			args = [message.data];
		} else if (typeof message.data === 'object') {
			args = message.data;
		}

		var method = (message.method || '').replace(/Sync$/, '');

		args.push(callback);

		switch(message.api) {
			case 'fs':
				// Make absolute paths relative
				// (They are absolute from the perspect of the sandboxed code)
				if (typeof args[0] === 'string' && args[0].indexOf('/') === 0) {
					args[0] = '.' + args[0];
				}
				fs[method].apply(null, args);
				break;

			case 'crypto':
				switch(method) {
					case 'randomBytes':
						// Convert the resulting buffer to hex
					function randomBytesCallback(error, result){
						if (error) {
							callback(error);
						} else if (Buffer.isBuffer(result)) {
							result = result.toString('hex');
							callback(null, result);
						}
					}

						args[args.length - 1] = randomBytesCallback;
						crypto.randomBytes.apply(null, args);
						break;
					default:
						callback(new Error('Unhandled net method: ' + message.method));
				}
				break;
			default:
				callback(new Error('Unhandled api type: ' + message.api));
		}
	}

	var sandbox = new Sandbox({
		api: apiHandler,
		enableGdb:  false,
		enableValgrind: false,
		disableNacl: true
	});

	sandbox.on("exit", function () {
		library.logger.info("DApp " + id + " closed");
	});

	sandbox.pipeStdout(process.stdout);
	sandbox.pipeStderr(process.stderr);

	sandbox.run(path.join("dapps", id, "index.js"),  { env: process.env });

	library.logger.info("DApp " + id + " launched");

	if (dAppConfig.jayson_port) {
		library.logger.info("Connect to communicate server of DApp " + id);

		var client = null;

		try {
			client = jayson.client.http({
				port: dAppConfig.jayson_port,
				hostname: 'localhost'
			});
		} catch (e) {
			sandbox.kill(0);
			delete private.sandboxes[id];
			return setImmediate(cb, "Can't connect to communicate server of DApp " + id);
		}

		private.clients[id] = client;

		try {
			var dAppRoutes = require(path.join(dAppPath, "api", "routes.js"));
		} catch (e) {
			sandbox.kill(0);
			delete private.sandboxes[id];
			delete private.clients[id];
			return setImmediate(cb, "Can't connect to api of DApp " + id + " , routes file not found");
		}

		private.initializeDAppRoutes(id, dAppRoutes, function (err) {
			if (err) {
				sandbox.kill(0);
				delete private.sandboxes[id];
				delete private.clients[id];
				return setImmediate(cb, "Can't launch api, incorrect routes object of DApp " + id);
			} else {
				private.sandboxes[id] = sandbox;
				return setImmediate(cb);
			}
		});
	} else {
		private.sandboxes[id] = sandbox;
		return setImmediate(cb);
	}
}

private.get = function (id, cb) {
	library.dbLite.query("SELECT name, description, tags, git FROM dapps WHERE transactionId=$id", {
		id : id
	}, ['name', 'description', 'tags', 'git'], function (err, rows) {
		if (err || rows.length == 0) {
			return cb(err.toString() || "Can't find dapp with id " + id);
		} else {
			var dapp = rows[0];
			dapp.id = id;
			return cb(null, dapp);
		}
	})
}

function DApp() {
	this.create = function (data, trs) {
		trs.recipientId = null;
		trs.amount = 0;
		trs.asset.dapp = {
			name: data.name,
			description: data.description,
			git: data.git,
			tags: data.tags
		};

		return trs;
	}

	this.calculateFee = function (trs) {
		return 100 * constants.fixedPoint;
	}

	this.verify = function (trs, sender, cb) {
		if (trs.asset.dapp.name.length == 0 || trs.asset.dapp.name > 16) {
			return cb("Incorrect dapp name length");
		}

		if (trs.asset.dapp.description) {
			if (trs.asset.dapp.description.length > 160) {
				return cb("Incorrect dapp description length");
			}
		}

		if (trs.asset.tags) {
			if (trs.asset.tags.length > 160) {
				return cb("Incorrect dapp tags length");
			}
		}

		////////////
		// check that trs.asset.git link to git repo
		// important!
		////////////

		if (trs.amount != 0) {
			return cb("Invalid transaction amount");
		}

		async.parallel([
			function (cb) {
				library.dbLite.query("SELECT COUNT(transactionId) FROM dapps WHERE name = $name", {
					name: trs.asset.dapp.name
				}, ['count'], function (err, rows) {
					if (err || rows.length == 0) {
						cb("Sql error");
					} else {
						var count = parseInt(rows[0].count);

						if (count > 0) {
							cb("This name already using in DApp Store");
						} else {
							cb();
						}
					}
				});
			},
			function (cb) {
				library.dbLite.query("SELECT COUNT(transactionId) FROM dapps WHERE git = $git", {
					git: trs.asset.dapp.git
				}, ['count'], function (err, rows) {
					if (err || rows.length == 0) {
						cb("Sql error");
					} else {
						var count = parseInt(rows[0].count);

						if (count > 0) {
							cb("This git repository already using in DApp Store");
						} else {
							cb();
						}
					}
				});
			}
		], function (err) {
			if (err) {
				return cb(err);
			} else {
				return cb(null, trs);
			}
		});
	}

	this.getBytes = function (trs) {
		try {
			var name = new Buffer(trs.asset.dapp.name, 'utf8');
			var description = new Buffer(trs.asset.dapp.description || '', 'utf8');
			var tags = new Buffer(trs.asset.dapp.tags || '', 'utf8');
			var git = new Buffer(trs.asset.dapp.git, 'utf8');

			var buffer = Buffer.concat([name, description, tags, git]);
		} catch (e) {
			throw Error(e.toString());
		}

		return buffer;
	}

	this.apply = function (trs, sender) {
		sender.isUnconfirmedDAppAccount = false;
		sender.isDAppAccount = true;
		return true;
	}

	this.undo = function (trs, sender) {
		sender.isDAppAccount = false;
		sender.isUnconfirmedDAppAccount = true;
		return true;
	}

	this.applyUnconfirmed = function (trs, sender) {
		if (private.unconfirmedNames[trs.asset.dapp.name]) {
			return false;
		}

		if (private.unconfirmedLinks[trs.asset.dapp.git]) {
			return false;
		}

		if (sender.isDAppAccount || sender.isUnconfirmedDAppAccount)  {
			return false;
		}

		private.unconfirmedNames[trs.asset.dapp.name] = true;
		private.unconfirmedLinks[trs.asset.dapp.git] = true;
		sender.isUnconfirmedDAppAccount = true;
		return true;
	}

	this.undoUnconfirmed = function (trs, sender) {
		private.unconfirmedNames[trs.asset.dapp.name] = false;
		private.unconfirmedLinks[trs.asset.dapp.git] = false;
		sender.isUnconfirmedDAppAccount = false;
		return true;
	}

	this.objectNormalize = function (trs) {
		var report = RequestSanitizer.validate(trs.asset.dapp, {
			object: true,
			properties: {
				name: "string!",
				description: "string!",
				tags: "string!",
				git: "string!"
			}
		});

		if (!report.isValid) {
			throw Error(report.issues);
		}

		trs.asset.dapp = report.value;

		return trs;
	}

	this.dbRead = function (raw) {
		if (!raw.da_name) {
			return null;
		} else {
			var dapp = {
				transactionId: raw.t_id,
				name: raw.da_name,
				description: raw.da_description,
				tags: raw.da_tags,
				git: raw.da_git
			}

			return {dapp: dapp};
		}
	}

	this.dbSave = function (dbLite, trs, cb) {
		dbLite.query("INSERT INTO dapps(transactionId, name, description, tags, git) VALUES($transactionId, $name, $description, $tags, $git)", {
			transactionId: trs.id,
			name: trs.asset.dapp.name,
			description: trs.asset.dapp.description? trs.asset.dapp.description : null,
			tags: trs.asset.dapp.tags? trs.asset.dapp.tags : null,
			git: trs.asset.dapp.git
		}, cb);
	}

	this.ready = function (trs) {
		return true;
	}
}

function attachApi() {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: 'loading'});
	});

	router.put('/', function (req, res) {
		req.sanitize("body", {
			secret: "string!",
			secondSecret: "string",
			publicKey: "hex?",
			name: "string!",
			description: "string",
			tags: "string",
			git: "string!"
		}, function (err, report, body) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issues});

			var hash = crypto.createHash('sha256').update(body.secret, 'utf8').digest();
			var keypair = ed.MakeKeypair(hash);

			if (body.publicKey) {
				if (keypair.publicKey.toString('hex') != body.publicKey) {
					return res.json({success: false, error: "Please, provide valid secret key of your account"});
				}
			}

			var account = modules.accounts.getAccountByPublicKey(keypair.publicKey.toString('hex'));

			if (!account) {
				return res.json({success: false, error: "Account doesn't has balance"});
			}

			if (!account.publicKey) {
				return res.json({success: false, error: "Open account to make transaction"});
			}

			if (account.secondSignature && !body.secondSecret) {
				return res.json({success: false, error: "Provide second password"});
			}

			var secondKeypair = null;

			if (account.secondSignature) {
				var secondHash = crypto.createHash('sha256').update(body.secondSecret, 'utf8').digest();
				secondKeypair = ed.MakeKeypair(secondHash);
			}

			var transaction = library.logic.transaction.create({
				type: TransactionTypes.DAPP,
				name: body.name,
				description: body.description,
				tags: body.tags,
				git: body.git,
				sender: account,
				keypair: keypair,
				secondKeypair: secondKeypair
			});

			library.sequence.add(function (cb) {
				modules.transactions.receiveTransactions([transaction], cb);
			}, function (err) {
				if (err) {
					return res.json({success: false, error: err});
				}

				res.json({success: true, transaction: transaction});
			});
		});
	});

	router.post("/install", function (req, res) {
		req.sanitize("body", {
			id: "string!"
		}, function (err, report, body) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issues});

			var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

			if (library.config.dapps.access.whiteList.length > 0 && library.config.dapps.access.whiteList.indexOf(ip) < 0) {
				return res.json({success: false, error: "Accesss denied"});
			}

			private.get(body.id, function (err, dapp) {
				if (err) {
					return res.json({success: false, error: err});
				} else {
					private.installDApp(dapp, function (err, path) {
						if (err) {
							return res.json({success:false, error: err});
						} else {
							return res.json({success:true, path: path});
						}
					});
				}
			})

		});
	});

	router.post("/launch", function (req, res) {
		req.sanitize("body", {
			id: "string!"
		}, function (err, report, body) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issues});

			var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

			if (library.config.dapps.access.whiteList.length > 0 && library.config.dapps.access.whiteList.indexOf(ip) < 0) {
				return res.json({success: false, error: "Accesss denied"});
			}

			private.get(body.id, function (err, dapp) {
				if (err) {
					return res.json({success: false, error: err});
				} else {
					private.launchDApp(dapp, function (err, sandbox) {
						if (err) {
							return res.json({success:false, error: err});
						} else {
							return res.json({success:true});
						}
					});
				}
			});
		});
	});

	library.network.app.use('/api/dapps', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});
}

function DApps(cb, scope) {
	library = scope;
	self = this;
	self.__private = private;
	attachApi();

	private.createBasePath();

	library.logic.transaction.attachAssetType(TransactionTypes.DAPP, new DApp());

	setImmediate(cb, null, self);
}

DApps.prototype.onBind = function (scope) {
	modules = scope;
}

module.exports = DApps;