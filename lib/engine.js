/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const debug = require('debug')('xpl-upnp-avtransport:engine');
const Async = require('async');
const IP = require('ip');
const http = require('http');
const os = require('os');

const Device = require('./device');

class Engine {
	constructor(xpl, upnpClient) {
		this._xpl = xpl;
		this._upnpClient = upnpClient;

		this._avTransports = {};
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
			  debug("server", "Receive chunck=",chunck);
			});

			request.on('end', () => {
				var b = String(Buffer.concat(body));

				debug("server", "Request to our server body=", b, "from", request.address, request.headers);

				var nt = request.headers.nt;
				var sid = request.headers.sid;

				debug("server", "nt=", nt, "sid=", sid);
				if (nt === "upnp:event" && sid) {
					for (var k in this._avTransports) {
						var device = this._avTransports[k];

						if (device.sid !== sid) {
							continue;
						}

						device.processEvent(b, request, (error) => {
							if (error) {
								console.error(error);
							}
						});
						break;
					}
				}

				response.writeHead(200, {});

				response.end();
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

	processXplMessage(message) {
		console.log("Get xpl message=", message);
	}

	processUpnpResponse(headers, statusCode, address) {
		debug("processUpnpResponse", "Headers=", headers, "statusCode=", statusCode, "address=", address);

		var usn = headers.USN;
		if (!usn) {
			return;
		}

		var reg = /^(.*)::(.*)$/.exec(usn);
		if (reg) {
			usn = reg[1];
		}

		var av = this._avTransports[usn];
		if (av) {
			//av.ping(headers, statusCode, address);
			return;
		}

		if (statusCode !== 200) {
			return;
		}

		av = new Device(this, usn, headers, address);
		this._avTransports[usn] = av;

		av.connect(headers, statusCode, address);
	}
}

module.exports = Engine;
