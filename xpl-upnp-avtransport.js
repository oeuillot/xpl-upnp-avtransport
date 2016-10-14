/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const Xpl = require("xpl-api");
const commander = require('commander');
const os = require('os');
const debug = require('debug')('xpl-upnp-avtransport:cli');
const Client = require('node-ssdp').Client;

const Engine = require('./lib/engine');

commander.version(require("./package.json").version);
commander.option("-a, --deviceAliases <aliases>", "Devices aliases");

commander.option("--heapDump", "Enable heap dump (require heapdump)");

Xpl.fillCommander(commander);

commander
	.command('run')
	.description("Start listening upnp avtransports")
	.action(() => {
		console.log("Start");


		if (!commander.xplSource) {
			var hostName = os.hostname();
			if (hostName.indexOf('.') > 0) {
				hostName = hostName.substring(0, hostName.indexOf('.'));
			}

			commander.xplSource = "upnp-avtransport." + hostName;
		}

		var deviceAliases = Xpl.loadDeviceAliases(commander.deviceAliases);

		debug("Device aliases=", deviceAliases);

		var xpl = new Xpl(commander);

		xpl.on("error", function (error) {
			console.error("XPL error", error);
		});

		xpl.bind(function (error) {
			if (error) {
				console.error("Can not open xpl bridge ", error);
				process.exit(2);
				return;
			}

			console.log("Xpl bind succeed ");
			// xpl.sendXplTrig(body, callback);


			var client = new Client(commander);

			var engine = new Engine(xpl, client, deviceAliases);

			engine.initialize((error) => {
				if (error) {
					console.error("Can not initialize engine", error);
					process.exit(3);
					return;
				}

				xpl.on("xpl:xpl-cmnd", (message) => {
					engine.processXplMessage(message, (error) => {
						if (error) {
							console.error("error=", error);
						}
					});
				});

				client.on('response', (headers, statusCode, rinfo) => {
					engine.processUpnpResponse(headers, statusCode, rinfo);
				});

				setInterval(() => {
					debug("interval", "Search new devices ...")
					client.search('urn:schemas-upnp-org:service:AVTransport:1');
					client.search('urn:schemas-upnp-org:service:RenderingControl:1');
				}, 5000);
			});
		});
	});

commander.parse(process.argv);

if (commander.headDump) {
	var heapdump = require("heapdump");
	console.log("***** HEAPDUMP enabled **************");
}
