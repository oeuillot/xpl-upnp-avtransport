/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const debug = require('debug')('xpl-upnp-avtransport:engine');
const debugRequest = require('debug')('xpl-upnp-avtransport:engine:request');
const Async = require('async');
const IP = require('ip');
const http = require('http');
const os = require('os');

const Device = require('./device');

class Engine {
	constructor(xpl, upnpClient, usnAliases) {
		this._xpl = xpl;
		this._upnpClient = upnpClient;

		this._usnAliases = usnAliases;

		this._upnpServices = {};
	}

	getHttpUrl(requestAddress) {
		var interfaces = os.networkInterfaces();

		var ra = requestAddress.address;
		var port = this._httpServer.address().port;

		var ret;
		for (var name in interfaces) {
			var i0 = interfaces[name];

			ret = i0.find((i) => {
				if (i.family != requestAddress.family) {
					return;
				}
				var ct = IP.subnet(i.address, i.netmask).contains(ra);

				return (ct) ? i : null;
			});

			if (ret) {
				break;
			}
		}

		if (ret) {
			debug("getHttpUrl", "ServerURL=", ret.address);
			return "http://" + ret.address + ":" + port + "/";
		}

		var ia = IP.address();

		debug("getHttpUrl", "Default ServerURL=", ia);

		var url = "http://" + ia + ":" + port + "/";
		return url;
	}

	initialize(callback) {

		var server = http.createServer((request, response) => {
			var body = [];
			request.on('data', (chunk) => {
				if (chunk.length) {
					body.push(chunk);
				}
				debugRequest("server", "Receive chunk=", chunk);
			});

			request.on('end', () => {
				var b = String(Buffer.concat(body));

				debugRequest("server", "Body=", b);

				this._processRequest(request, response, b);
			});
		});

		this._httpServer = server;

		server.on('clientError', (err, socket) => {
			socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
		});

		server.listen(0, () => {
			var address = server.address();

			debug("Server listening on port ", address.port);

			callback();
		});
	}

	_processRequest(request, response, body) {

		debugRequest("_processRequest", "Request to our server body=", body, "from address=", request.address, "headers=", request.headers);

		var nt = request.headers.nt;
		var sid = request.headers.sid;

		debug("_processRequest", "nt=", nt, "sid=", sid);
		if (nt === "upnp:event" && sid) {
			var found = false;
			for (var k in this._upnpServices) {
				var device = this._upnpServices[k];

				if (device.sid !== sid) {
					continue;
				}

				device.processEvent(body, request, (error) => {
					if (error) {
						console.error("Process event error=", error);
					}
				});
				found = true;
				break;
			}

			if (!found) {
				debug("_processRequest", "Can not find sid=", sid);
			}
		} else {
			debug("_processRequest", "Unsupported request headers=", headers);
		}

		response.writeHead(200, {});

		response.end();
	}

	processXplMessage(message, callback) {
		//console.log("Get xpl message=", message);

		let s = message.body.device;
		if (!s) {
			debug("processXplMessage", "No device in body=", message.body);

//			let ex = new Error("No device in body");
//			ex.message = message;
			callback();
			return;
		}


		let deviceName;
		let instanceId;

		let reg = /([^\/]+)\/([\d]+)$/.exec(s);
		if (reg) {
			deviceName = reg[1];
			instanceId = reg[2];

		} else {
			let reg = /([^\/]+)$/.exec(s);
			if (reg) {
				deviceName = reg[1];
				instanceId = 0;
			}
		}


		if (!deviceName) {
			debug("processXplMessage", "Invalid device pattern=", s);
//			let ex = new Error("Invalid device pattern");
//			ex.message = message;
//			ex.device = s;

			callback();
			return;
		}

		let found = 0;

		var dn = new RegExp(deviceName.replace(/[|\\{}()[\]^$+.]/g, '\\$&').replace(/\*/g, '.*'), 'i');

		Async.forEachOf(this._upnpServices, (device, deviceKey, callback) => {
			if (!dn.test(device.ausn)) {
				callback();
				return;
			}

			found++;

			device.processXplMessage(message, instanceId, (error) => {
				if (error) {
					console.error("Process XPL message error=", error);
				}

				callback();
			});

		}, (error) => {
			if (!found) {
				debug("processXplMessage", "Can not find device=", deviceName, "for regexp=", dn);
			}

			callback(error);
		});
	}

	processUpnpResponse(headers, statusCode, address) {
		//debug("processUpnpResponse", "Headers=", headers, "statusCode=", statusCode, "address=", address);

		var usn = headers.USN;
		if (!usn) {
			console.error("No USN in the headers=", headers);
			return;
		}

		var reg = /^(.*)::(.*)$/.exec(usn);
		if (reg) {
			usn = reg[1];
		}

		var av = this._upnpServices[usn];
		if (av) {
			debug("processUpnpResponse", "The device usn=", usn, "is already known.")
			av.ping(headers, statusCode, address);
			return;
		}

		if (statusCode !== 200) {
			debug("processUpnpResponse", "Invalid status code=", statusCode);
			return;
		}

		debug("processUpnpResponse", "New device usn=", usn, ", register it !");

		var ausn = usn;
		if (this._usnAliases) {
			ausn = this._usnAliases[usn] || usn;
		}

		av = new Device(this, usn, headers, address, ausn);
		this._upnpServices[usn] = av;

		av.connect(headers, statusCode, address);
	}
}

module.exports = Engine;
