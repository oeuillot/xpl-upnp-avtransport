/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const debug = require('debug')('xpl-upnp-avtransport:engine');
const Async = require('async');
const Request = require('request');
const Xmldoc = require('./xmldoc');
const Url = require('url');

const TIMEOUT_SECOND = 60 * 30;

class Device {
	constructor(engine, usn, headers, address) {
		debug("Device", "New device usn=", usn);

		this._engine = engine;
		this.usn = usn;
		this._headers = headers;

		this._remoteAddress = address;
		this._connected = false;
		this._lastPing = 0;
	}

	connect(headers, statusCode, address) {
		debug("Connect", "Usn=", this.usn, "statusCode=", statusCode, "address=", address);

		if (statusCode != 200) {
			return;
		}
		this._lastPing = Date.now();
		if (this._connected) {
			return;
		}

		this._connected = true;

		Request.get(headers.LOCATION, (error, response, body) => {
			debug("connect:get", "Location=", headers.LOCATION, "Response=", response.statusCode, "body=", body);
			if (error) {
				console.error(error);
				return;
			}
			if (response.statusCode != 200) {
				console.error("connect: Invalid status code", response.statusCode, "from", headers.LOCATION);
				return;
			}

			var contentType = response.headers["content-type"];
			if (contentType) {
				var reg = /^([^;\s]+)/.exec(contentType);
				if (reg) {
					contentType = reg[1];
				}
			}
			if (contentType !== "text/xml") {
				console.error("connect: Invalid response type ", contentType, "from", headers.LOCATION);
				return;
			}

			var xml = new Xmldoc.XmlDocument(body);
			var sl = xml.descendantWithPath("device.serviceList");
			var avt;
			if (sl) {
				avt = sl.childrenNamed("service").find((node) => {
					var st = node.valueWithPath("serviceType");
					var eventUrl = node.valueWithPath("eventSubURL");

					return (st === 'urn:schemas-upnp-org:service:AVTransport:1') && eventUrl;
				});
			}
			if (!avt) {
				console.log(">>>", xml);
				console.error("connect: no event engine from", headers.LOCATION);
				return;
			}

			var url = Url.resolve(headers.LOCATION, avt.valueWithPath("eventSubURL"));
			this._eventURL = url;

			url = Url.resolve(headers.LOCATION, avt.valueWithPath("controlURL"));
			this._controlURL = url;

			debug("connect", "EventURL=", url, "for", headers.LOCATION);

			this._subscribe((error) => {
				if (error) {
					console.error(error);
				}
			});
		});

	}

	_refresh(callback) {
		var params = {
			url: this._eventURL,
			method: "SUBSCRIBE",
			headers: {
				SID: this.sid,
				TIMEOUT: 'Second-' + this._timeoutSeconds
			}
		};

		debug("_refresh", "Params=", params);
		Request(params, (error, response, body) => {
			if (error) {
				this._errorCount++;
				console.error(error);
				return callback(error);
			}

			if (response.statusCode !== 200) {
				this._errorCount++;
				return callback("Invalid status code (" + response.statusCode + ")");
			}

			this._errorCount = 0;

			callback();
		});
	}

	_subscribe(callback) {

		var httpURL = this._engine.getHttpUrl(this._remoteAddress);
		if (!httpURL) {
			return callback();
		}

		var params = {
			url: this._eventURL,
			method: "SUBSCRIBE",
			headers: {
				CALLBACK: "<" + httpURL + ">",
				NT: 'upnp:event',
				TIMEOUT: 'Second-' + TIMEOUT_SECOND
			}
		};

		debug("_subscribe", "Params=", params);
		Request(params, (error, response, body) => {
			if (error) {
				console.error(error);

				return callback();
			}

			if (response.statusCode === 200) {
				var sid = response.headers['sid'];

				debug("_subscribe", "Set sid to", sid);

				this.sid = sid;

				var timeout = response.headers['timeout'];
				var reg = /Second-([\d]+)/i.exec(timeout);
				var seconds = TIMEOUT_SECOND;
				if (reg) {
					seconds = parseInt(reg[1], 10);
				}
				this._timeoutSeconds = seconds;

				debug("_subscribe", "Set timeout to", seconds);

				this._syncIntervalId = setInterval(()=> {
					this._refresh((error) => {
						if (error) {
							console.error(error);
						}
					});
				}, seconds * 1000);
			}

			callback();
		});
	}

	requestVars(varName, callback) {
		var body = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" \
      s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"> \
      <s:Body> \
      <u:QueryStateVariable xmlns:u="urn:schemas-upnp-org:control-1-0"> \
      <u:varName>${varName}</u:varName> \
      </u:QueryStateVariable> \
      </s:Body> \
      </s:Envelope>`;

		var params = {
			url: this._controlURL,
			method: "POST",
			headers: {
				SOAPACTION: '"urn:schemas-upnp-org:control-1-0#QueryStateVariable"',
				'Content-Type': 'text/xml; charset="utf-8"'
			},
			body: body
		};

		debug("requestVars", "Vars=", vars, "Params=", params);
		Request(params, (error, response, body) => {
			if (error) {
				console.error(error);

				return callback();
			}
			if (response.statusCode != 200) {
				console.error("Invalid status code", response.statusCod)
			}

			console.log("Response=", body);

			var xml = new Xmldoc.XmlDocument(body);

			debug("requestVars", "Reponse xml=", xml);

			var ret = xml.valueWithPath("s:Body.u:QueryStateVariableResponse.return");

			callback(null, ret);
		});
	}

	processEvent(body, request, callback) {
	  body=String(body);
	  console.log("Event.body=",body);
	  
		var xml = new Xmldoc.XmlDocument(body);
		var sl = xml.valueWithPath("e:property.LastChange");

		if (!sl) {
			debug("processEvent", "No lastChange in " + body);
			return callback();
		}
		console.log("processEvent", "LastChange=", sl);

		var xml2 = new Xmldoc.XmlDocument(sl);
		var instanceID = xml2.valueWithPath("InstanceID@val") || 0;

		var uri = xml2.valueWithPath("InstanceID.AVTransportURI@val");
		if (uri) {
			this._processURIChanged(instanceID, uri, callback);
		}

		var currentTrackDuration = xml2.valueWithPath("InstanceID.CurrentTrackDuration@val");
		if (state) {
			this._processCurrentTrackDurationChanged(instanceID, currentTrackDuration, callback);
		}

		var state = xml2.valueWithPath("InstanceID.TransportState@val");
		if (state) {
			this._processStateChanged(instanceID, state, callback);
		}

		callback();
	}

	_processStateChanged(instanceID, state, callback) {
		var xpl = this._engine._xpl;

		this._currentState = state;

		var body = {
			device: this.usn,
			intanceID: instanceID,
			type: "status",
			state: state
		};

		debug("_processStateChanged", "Set state changed  newState=", state, "instanceID=", instanceID);

		xpl.sendXplStat(body, "audio.upnp", callback);
	}

	_processCurrentTrackDurationChanged(instanceID, currentTrackDuration, callback) {
		var xpl = this._engine._xpl;

		this._currentTrackDuration = currentTrackDuration;

		var body = {
			device: this.usn,
			intanceID: instanceID,
			type: "currentTrackDuration",
			state: currentTrackDuration
		};

		debug("_processCurrentTrackDurationChanged", "Set currentTrackDuration changed  newDuration=", currentTrackDuration, "instanceID=", instanceID);

		xpl.sendXplStat(body, "audio.upnp", callback);
	}

	_processURIChanged(instanceID, uri, callback) {
		var xpl = this._engine._xpl;

		this._currentURI = uri;

		var body = {
			device: this.usn,
			intanceID: instanceID,
			type: "source",
			state: uri
		};

		debug("_processURIChanged", "Set uri changed  newURI=", uri, "instanceID=", instanceID);

		xpl.sendXplStat(body, "audio.upnp", callback);
	}
}

module.exports = Device;