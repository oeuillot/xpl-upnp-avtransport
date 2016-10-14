/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const Debug = require('debug');
const debug = Debug('xpl-upnp-avtransport:device');
const Async = require('async');
const Request = require('request');
const Xmldoc = require('xmldoc');
const Url = require('url');

const TIMEOUT_SECOND = 60 * 30;

const AVTRANSPORT_USN = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_USN = 'urn:schemas-upnp-org:service:RenderingControl:1';

const DEFAULT_CHANNEL = "Master";

const EVENT_PROPS = {
	"InstanceID.AVTransportURI@val": "AVTransportURI",
	"InstanceID.CurrentTrack@val": "CurrentTrack",
	"InstanceID.CurrentTrackDuration@val": "CurrentTrackDuration",
	"InstanceID.TransportState@val": "TransportState",
	"InstanceID.CurrentPlayMode@val": "CurrentPlayMode"
};

const MEDIA_INFOS_PROPS = {
	"NrTracks": "NumberOfTracks",
	"MediaDuration": "CurrentMediaDuration",
	"CurrentURI": "AVTransportURI",
	"CurrentURIMetaData": "AVTransportURIMetaData",
	"NextURI": "NextAVTransportURI",
	"NextURIMetaData": "NextAVTransportURIMetaData"
};

const POSITION_INFOS_PROPS = {
	"TrackURI": "CurrentTrackURI",
	"Track": "CurrentTrack",
	"TrackDuration": "CurrentTrackDuration",
	"TrackMetaData": "CurrentTrackMetaData",
	"RelTime": "RelativeTimePosition",
	"AbsTime": "AbsoluteTimePosition",
	"RelCount": "RelativeCounterPosition",
	"AbsCount": "AbsoluteCounterPosition"
};

const TRANSPORT_INFOS_PROPS = {
	"CurrentTransportState": "TransportState",
	"CurrentTransportStatus": "TransportStatus",
	"CurrentSpeed": "TransportPlaySpeed"
};


class Device {
	/**
	 *
	 * @param {Engine} engine
	 * @param {string} usn
	 * @param {Object} headers
	 * @param address
	 */
	constructor(engine, usn, headers, address, ausn) {
		debug("Device", "New device usn=", usn, "address=", address, "ausn=", ausn);

		this._debug = Debug('xpl-upnp-avtransport:device:' + address.address);
		this._engine = engine;
		this.usn = usn;
		this.ausn = ausn || usn;
		this._headers = headers;

		this._remoteAddress = address;
		this._connected = false;
		this._lastPing = 0;
		this._currentVolumes = {};
		this._values = {};
	}

	connect(headers, statusCode, address) {
		this._debug("Connect", "Usn=", this.usn, "statusCode=", statusCode, "address=", address);

		if (statusCode != 200) {
			console.error("Connect: invalid status code=" + statusCode);
			return;
		}
		this._lastPing = Date.now();
		if (this._connected) {
			return;
		}

		this._connected = true;

		Request.get(headers.LOCATION, (error, response, body) => {
			this._debug("connect:get", "Location=", headers.LOCATION, "Response=", response.statusCode); //, "body=", body);
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
			let avt;
			let rendering;

			var sl = xml.descendantWithPath("device.serviceList");
			if (sl) {
				avt = sl.childrenNamed("service").find((node) => {
					var st = node.valueWithPath("serviceType");
					var curl = node.valueWithPath("controlURL");

					return (st === AVTRANSPORT_USN) && curl;
				});
				rendering = sl.childrenNamed("service").find((node) => {
					var st = node.valueWithPath("serviceType");
					var curl = node.valueWithPath("controlURL");

					return (st === RENDERING_USN) && curl;
				});
			}

			if (!avt) {
				//debug("No AVTransport detected", xml);

				this._debug("connect", "no AVT Transport for location=", headers.LOCATION);

			} else {
				let eurl = Url.resolve(headers.LOCATION, avt.valueWithPath("eventSubURL"));
				let curl = Url.resolve(headers.LOCATION, avt.valueWithPath("controlURL"));
				this._avtControlURL = curl;

				this._debug("connect", "AVTTransport: EventURL=", eurl, "ControlURL=", curl, "for", headers.LOCATION);

				if (eurl) {
					this._subscribe(eurl, (error) => {
						if (error) {
							console.error(error);
						}
					});
				}
				this._installAVPooling();
			}

			if (!rendering) {
				//debug("No AVTransport detected", xml);

				this._debug("connect", " No rendering for location=", headers.LOCATION);

			} else {
				let eurl = Url.resolve(headers.LOCATION, rendering.valueWithPath("eventSubURL"));
				let curl = Url.resolve(headers.LOCATION, rendering.valueWithPath("controlURL"));
				this._renderingControlURL = curl;

				this._debug("connect", "Rendering: EventURL=", eurl, "ControlURL=", curl, "for", headers.LOCATION);

				if (eurl) {
					this._subscribe(eurl, (error) => {
						if (error) {
							console.error(error);
						}
					});
				}
				this._installRenderingPooling();
			}
		});
	}

	ping(headers, statusCode, address) {


	}

	_refresh(eventURL, callback) {
		var params = {
			url: eventURL,
			method: "SUBSCRIBE",
			headers: {
				SID: this.sid,
				TIMEOUT: 'Second-' + this._timeoutSeconds
			}
		};

		this._debug("_refresh", "eventURL=", eventURL, "Params=", params);
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

	_subscribe(eventURL, callback) {

		var httpURL = this._engine.getHttpUrl(this._remoteAddress);
		if (!httpURL) {
			this._debug("_subscribe", "No HttpURL from remoteAddress=", this._remoteAddress);
			return callback();
		}

		var params = {
			url: eventURL,
			method: "SUBSCRIBE",
			headers: {
				CALLBACK: "<" + httpURL + ">",
				NT: 'upnp:event',
				TIMEOUT: 'Second-' + TIMEOUT_SECOND
			}
		};

		this._debug("_subscribe", "Request subscribe Params=", params);

		Request(params, (error, response, body) => {
			if (error) {
				console.error(error);

				return callback();
			}

			if (response.statusCode === 200) {
				var sid = response.headers['sid'];

				this._debug("_subscribe", "Subscribe success: Set sid to", sid, 'headers=', response.headers, 'body=', body);

				this.sid = sid;

				var timeout = response.headers['timeout'];
				var reg = /Second-([\d]+)/i.exec(timeout);
				var seconds = TIMEOUT_SECOND;
				if (reg) {
					seconds = parseInt(reg[1], 10);
				}
				this._timeoutSeconds = seconds;

				this._debug("_subscribe", "Set timeout to", seconds);

				this._syncIntervalId = setInterval(()=> {
					this._refresh(eventURL, (error) => {
						if (error) {
							console.error(error);
						}
					});
				}, (seconds - 5) * 1000);
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

		this._debug("requestVars", "varName=", varName, "Params=", params);
		Request(params, (error, response, body) => {
			if (error) {
				console.error(error);

				return callback(error);
			}

			if (response.statusCode != 200) {
				console.error("Invalid status code", response.statusCode);

				let ex = new Error("Invalid status code=" + response.statusCode);
				ex.statusCode = response.statusCode;
				ex.device = this;
				ex.response = response;

				return callback(ex);
			}

			//console.log("Response=", body);

			var xml = new Xmldoc.XmlDocument(body);

			this._debug("requestVars", "Reponse xml=", body);

			var ret = xml.valueWithPath("s:Body.u:QueryStateVariableResponse.return");

			this._debug("requestVars", "State variable response=", ret);

			callback(null, ret);
		});
	}

	requestPositionInfo(instanceID, callback) {
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "GetPositionInfo", callback);
	}

	requestMediaInfo(instanceID, callback) {
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "GetMediaInfo", callback);
	}

	requestTransportInfo(instanceID, callback) {
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "GetTransportInfo", callback);
	}

	requestVolume(instanceID, channel, callback) {
		if (typeof(channel) === "function") {
			callback = channel;
			channel = undefined;
		}

		if (!channel) {
			channel = DEFAULT_CHANNEL;
		}

		this._requestUpnpService(instanceID, RENDERING_USN, this._renderingControlURL, "GetVolume", `<Channel>${channel}</Channel>`,
			callback);
	}

	_requestUpnpService(instanceID, ns, controlURL, action, body, callback) {
		if (typeof(body) === 'function') {
			callback = body;
			body = undefined;
		}

		var body = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" \
      s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"> \
      <s:Body> \
      <u:${action} xmlns:u="${ns}"> \
      <InstanceID>${instanceID}</InstanceID> \
      ${body || ''} \
      </u:${action}> \
      </s:Body> \
      </s:Envelope>`;

		var params = {
			url: controlURL,
			method: "POST",
			headers: {
				SOAPACTION: `"${ns}#${action}"`,
				'Content-Type': 'text/xml; charset="utf-8"'
			},
			body: body
		};

		this._debug("requestPosition", "InstanceID=", instanceID, "Params=", params, "body=", body);
		Request(params, (error, response, body) => {
			if (error) {
				console.error(error);

				return callback(error);
			}

			if (response.statusCode != 200) {
				console.error("Invalid status code", response.statusCode);
				let ex = new Error("Invalid status code");
				ex.statusCode = response.statusCode;
				ex.requestParams = params;
				ex.instanceID = instanceID;
				return callback(ex);
			}

			this._debug("Response=", body);

			var xml = new Xmldoc.XmlDocument(body);

			var ret = xml.descendantWithPath(`s:Body.u:${action}Response`);

			//debug("requestPositions", "Response ret=", ret);

			callback(null, ret);
		});
	}

	processEvent(body, request, callback) {
		this._debug("processEvent", "body=", body);

		var xml = new Xmldoc.XmlDocument(body);
		var sl = xml.valueWithPath("e:property.LastChange");

		if (!sl) {
			this._debug("processEvent", "No lastChange in " + body);
			return callback();
		}
		this._debug("processEvent", "LastChange=", sl);

		let xml2 = new Xmldoc.XmlDocument(sl);
		let instanceID = xml2.valueWithPath("InstanceID@val") || 0;
		if (typeof(instanceID) === "string") {
			instanceID = parseInt(instanceID, 10);
		}

		this._propertiesChanged(xml2, instanceID, EVENT_PROPS, callback);
	}

	_propertiesChanged(xml2, instanceID, props, callback) {
		if (!xml2) {
			return callback();
		}

		let changes = {};
		let cmds = [];
		for (var k in props) {
			let v = xml2.valueWithPath(k);
			if (this._addPropertyChanged(cmds, instanceID, props[k], v)) {
				changes[props[k]] = v;
			}
		}

		Async.eachSeries(cmds, (fct, callback) => fct(callback), (error) => {
			callback(error, changes);
		});
	}

	_fillBody(instanceID, name, value) {

		if (!instanceID) {
			return {
				device: this.ausn + "/" + name,
				current: value
			};
		}

		return {
			device: this.ausn + "/" + instanceID + "/" + name,
			current: value
		};
	}

	_addPropertyChanged(cmds, instanceID, name, value) {
		if (value === null || value === undefined) {
			value = '';
		}

		if (value === this._values[name]) {
			return false;
		}

		cmds.push((callback) => {
			let xpl = this._engine._xpl;
			let old = this._values[name];

			this._debug("propChanged", "name=", name, "old=", old, "new=", value);

			this._values[name] = value;

			var body = this._fillBody(instanceID, name, value);

			this._debug("propChanged", "Set value changed  newValue=", value, "instanceID=", instanceID);

			xpl.sendXplStat(body, "sensor.basic", callback);
		});
		return true;
	}

	_updateVolume(instanceID, channel, callback) {
		if (!channel) {
			channel = DEFAULT_CHANNEL;
		}

		this.requestVolume(instanceID, channel, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updateVolume", "instanceId=", instanceID, "channel=", channel); //, "RequestPosition=", xml2);

			let props;
			if (channel) {
				props = {"CurrentVolume": channel + '/Volume'};

			} else {
				props = {"CurrentVolume": 'Volume'};
			}

			this._propertiesChanged(xml2, instanceID, props, callback);
		});
	}

	_updateMetaDatas(metaDatas, instanceID, callback) {
		if (!metaDatas) {
			callback();
			return;
		}

		let title;
		let artist;
		let genre;
		let originalTrackNumber;
		let album;

		if (metaDatas && /^<DIDL-Lite/.exec(metaDatas)) {
			try {
				let xml2 = new Xmldoc.XmlDocument(metaDatas);
				title = xml2.valueWithPath("item.dc:title");
				artist = xml2.valueWithPath("item.upnp:artist");
				genre = xml2.valueWithPath("item.upnp:genre");
				album = xml2.valueWithPath("item.upnp:album");
				originalTrackNumber = xml2.valueWithPath("item.upnp:originalTrackNumber");
			} catch (x) {
				console.error(x);
			}
		}

		let cmds = [];

		this._addPropertyChanged(cmds, instanceID, "MetaData/Title", title);
		this._addPropertyChanged(cmds, instanceID, "MetaData/Artist", artist);
		this._addPropertyChanged(cmds, instanceID, "MetaData/Genre", genre);
		this._addPropertyChanged(cmds, instanceID, "MetaData/Album", album);
		this._addPropertyChanged(cmds, instanceID, "MetaData/OriginalTrackNumber", originalTrackNumber);

		Async.eachSeries(cmds, (fct, callback) => fct(callback), callback);
	}

	_updatePositionInfo(instanceID, callback) {
		this.requestPositionInfo(instanceID, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updatePositionInfo", "instanceId=", instanceID); //, "RequestPosition=", xml2);

			this._propertiesChanged(xml2, instanceID, POSITION_INFOS_PROPS, (error, changes) => {
				if (error) {
					return callback(error);
				}

				let metaDatas = changes['CurrentTrackMetaData'];
				this._updateMetaDatas(metaDatas, instanceID, callback);
			});
		});
	}

	_updateMediaInfo(instanceID, callback) {
		this.requestMediaInfo(instanceID, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updateMediaInfo", "instanceId=", instanceID); //, "RequestPosition=", xml2);

			this._propertiesChanged(xml2, instanceID, MEDIA_INFOS_PROPS, (error, changes) => {
				if (error) {
					return callback(error);
				}

				let metaDatas = changes['AVTransportURIMetaData'];
				this._updateMetaDatas(metaDatas, instanceID, callback);
			});
		});
	}

	_updateTransportInfo(instanceID, callback) {
		this.requestTransportInfo(instanceID, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updateTransportInfo", "instanceId=", instanceID); //, "RequestPosition=", xml2);

			this._propertiesChanged(xml2, instanceID, TRANSPORT_INFOS_PROPS, callback);
		});
	}

	_installAVPooling() {
		this._AVIntervalId = setInterval(() => {

			this._updateMediaInfo(0, (error) => {
				if (error) {
					console.error(error);
				}

				this._updateTransportInfo(0, (error) => {
					if (error) {
						console.error(error);
					}

					if (this._values['TransportState'] !== 'PLAYING') {
						return;
					}

					this._updatePositionInfo(0, (error) => {
						if (error) {
							console.error(error);
						}
					});
				});
			});
		}, 1000);
	}

	_installRenderingPooling() {
		this._renderingIntervalId = setInterval(() => {

			this._updateVolume(0, DEFAULT_CHANNEL, (error) => {
				if (error) {
					console.error(error);
				}
			});
		}, 5000);
	}

	stop(instanceID, callback) {
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "Stop", callback);
	}

	pause(instanceID, callback) {
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "Pause", callback);
	}

	play(instanceID, speed, callback) {
		if (typeof(speed) === "function") {
			callback = speed;
			speed = undefined;

		}
		if (!speed) {
			speed = 1;
		}
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "Play", `<Speed>{speed}</Speed>`, callback);
	}

	setVolume(instanceID, channel, desiredVolume, callback) {
		if (!channel) {
			channel = DEFAULT_CHANNEL;
		}
		this._requestUpnpService(instanceID, RENDERING_USN, this._renderingControlURL, "SetVolume", `<Channel>{channel}</Channel><DesiredVolume>{desiredVolume}</DesiredVolume>`, callback);
	}

	processXplMessage(message, property, instanceId, callback) {
		this._debug("Action property=", property, "instanceId=", instanceId, "value=", value);

		if (message.bodyName == "upnp.audio") {
			switch (property) {
				case 'command':
					switch (value) {
						case 'play':
							this.play(instanceId, 1, callback);
							return;
						case 'pause':
							this.pause(instanceId, callback);
							return;
						case 'stop':
							this.stop(instanceId, callback);
							return;
					}
				case 'volume':
					this.setVolume(instanceId, message.channel, message.value, callback);
					return;
			}
		}
	}
}

module.exports = Device;