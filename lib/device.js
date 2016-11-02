/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const Debug = require('debug');
const debug = Debug('xpl-upnp-avtransport:device');
const Async = require('async');
const Request = require('request');
const Xmldoc = require('xmldoc');
const Url = require('url');
const Et = require('elementtree');
const assert = require('assert');

const TIMEOUT_SECOND = 60 * 30;

const AVTRANSPORT_USN = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_CONTROL_USN = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CONNECTION_MANAGER_USN = 'urn:schemas-upnp-org:service:ConnectionManager:1';

const AVTRANSPORT_XPL_NAME = "upnp.AVTransport";
const RENDERING_CONTROL_XPL_NAME = "upnp.RenderingControl";

const DEFAULT_CHANNEL = "Master";

const AVTRANSPORT_EVENT_PROPS = {
	"InstanceID.CurrentTrack@val": "currentTrack",
	"InstanceID.NumberOfTracks@val": "numberOfTracks",
	"InstanceID.CurrentTrackDuration@val": "currentTrackDuration",
	"InstanceID.CurrentMediaDuration@val": "currentMediaDuration",
	"InstanceID.TransportState@val": "transportState",
	"InstanceID.TransportStatus@val": "transportStatus",
	"InstanceID.TransportPlaySpeed@val": "transportPlaySpeed",
	"InstanceID.CurrentPlayMode@val": "currentPlayMode",
	"InstanceID.CurrentTrackMetaData@val": "currentTrackMetaData",
	"InstanceID.CurrentTrackURI@val": "currentTrackURI",
	"InstanceID.AVTransportURI@val": "AVTransportURI",
	"InstanceID.AVTransportMetaData@val": "AVTransportMetaData",
	"InstanceID.NextAVTransportURI@val": "nextAVTransportURI",
	"InstanceID.NextAVTransportMetaData@val": "nextAVTransportMetaData"
};

const RENDERING_CONTROL_EVENT_PROPS = {};

const MEDIA_INFOS_PROPS = {
	"NrTracks": "numberOfTracks",
	"MediaDuration": "currentMediaDuration",
	"CurrentURI": "AVTransportURI",
	"CurrentURIMetaData": "AVTransportURIMetaData",
	"NextURI": "nextAVTransportURI",
	"NextURIMetaData": "nextAVTransportURIMetaData"
};

const POSITION_INFOS_PROPS = {
	"TrackURI": "currentTrackURI",
	"Track": "currentTrack",
	"TrackDuration": "currentTrackDuration",
	"TrackMetaData": "currentTrackMetaData",
	"RelTime": "relativeTimePosition",
	"AbsTime": "absoluteTimePosition",
	"RelCount": "relativeCounterPosition",
	"AbsCount": "absoluteCounterPosition"
};

const TRANSPORT_INFOS_PROPS = {
	"CurrentTransportState": "transportState",
	"CurrentTransportStatus": "transportStatus",
	"CurrentSpeed": "transportPlaySpeed"
};


class Device {
	/**
	 *
	 * @param {Engine} engine
	 * @param {string} usn
	 * @param {Object} headers
	 * @param address
	 */
	constructor(engine, usn, headers, address, ausn, configuration) {
		debug("Device", "New device usn=", usn, "address=", address, "ausn=", ausn, "configuration=", configuration);

		this._debug = Debug('xpl-upnp-avtransport:device:' + address.address);

		this._engine = engine;
		this.usn = usn;
		this.ausn = ausn || usn;
		this._headers = headers;

		configuration = configuration || {};
		let devicesConfiguration = configuration.devices || {};
		this._configuration = Object.assign({}, configuration, devicesConfiguration[usn] || {});

		this._remoteAddress = address;
		this._connected = false;
		this._lastPing = 0;
		this._currentVolumes = {};
		this._values = {};
		this._services = {};
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
			let connectionManager;

			var sl = xml.descendantWithPath("device.serviceList");
			if (sl) {
				avt = sl.childrenNamed("service").find((node) => {
					let st = node.valueWithPath("serviceType");
					let curl = node.valueWithPath("controlURL");

					return (st === AVTRANSPORT_USN) && curl;
				});
				rendering = sl.childrenNamed("service").find((node) => {
					let st = node.valueWithPath("serviceType");
					let curl = node.valueWithPath("controlURL");

					return (st === RENDERING_CONTROL_USN) && curl;
				});
				connectionManager = sl.childrenNamed("service").find((node) => {
					let st = node.valueWithPath("serviceType");
					let curl = node.valueWithPath("controlURL");

					return (st === CONNECTION_MANAGER_USN) && curl;
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
					let service = {eventURL: eurl, errorCount: 0, type: 'AVTransport'};
					this._subscribe(service, (error) => {
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
					let service = {eventURL: eurl, errorCount: 0, type: 'RenderingControl'};
					this._subscribe(service, (error) => {
						if (error) {
							console.error(error);
						}
					});
				}
				this._installRenderingPooling();
			}

			if (!connectionManager) {
				//debug("No AVTransport detected", xml);

				this._debug("connect", " No connectionManager for location=", headers.LOCATION);

			} else {
				let eurl = Url.resolve(headers.LOCATION, connectionManager.valueWithPath("eventSubURL"));
				let curl = Url.resolve(headers.LOCATION, connectionManager.valueWithPath("controlURL"));
				this._connectionManagerURL = curl;

				this._debug("connect", "ConnectionManager: EventURL=", eurl, "ControlURL=", curl, "for", headers.LOCATION);

				if (eurl) {
					let service = {eventURL: eurl, errorCount: 0, type: 'ConnectionManager'};

					this._subscribe(service, (error) => {
						if (error) {
							console.error(error);
						}
					});
				}
			}
		});
	}

	ping(headers, statusCode, address) {
	}

	/**
	 *
	 * @param {string} eventURL
	 * @param {Function} callback
	 * @private
	 */
	_refresh(service, callback) {

		var params = {
			url: service.eventURL,
			method: "SUBSCRIBE",
			headers: {
				SID: service.sid,
				TIMEOUT: 'Second-' + service.timeoutSeconds
			}
		};

		this._debug("_refresh", "eventURL=", service.eventURL, "Params=", params);
		Request(params, (error, response, body) => {
			if (error) {
				service.errorCount++;
				console.error(error);
				return callback(error);
			}

			if (response.statusCode !== 200) {
				service.errorCount++;
				return callback("Invalid status code (" + response.statusCode + ")");
			}

			service.errorCount = 0;

			callback();
		});
	}

	_subscribe(service, callback) {

		var httpURL = this._engine.getHttpUrl(this._remoteAddress) + this.usn.replace(/:/g, '-');
		if (!httpURL) {
			this._debug("_subscribe", "No HttpURL from remoteAddress=", this._remoteAddress);
			return callback();
		}

		var params = {
			url: service.eventURL,
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
				return callback(error);
			}

			if (response.statusCode !== 200) {
				debug("_subscribe", "Unsupported status code=", response.statusCode, "message=", response.statusMessage);
				let ex = new Error("Unsupported status");
				ex.code = 'INVALID_STATUS_CODE';
				ex.service = service;
				ex.params = params;
				ex.statusCode = response.statusCode;
				ex.statusMessage = response.statusMessage;
				callback(ex);
				return;
			}

			var sid = response.headers['sid'];
			service.sid = sid;
			this._services[sid] = service;

			this._debug("_subscribe", "Subscribe success: Set sid to", sid, 'eventURL=', service.eventURL, 'headers=', response.headers, 'body=', body);

			var timeout = response.headers['timeout'];
			var reg = /Second-([\d]+)/i.exec(timeout);
			var seconds = TIMEOUT_SECOND;
			if (reg) {
				seconds = parseInt(reg[1], 10);
			}
			service.timeoutSeconds = seconds;

			this._debug("_subscribe", "Set timeout to", seconds, "for eventURL=", service.eventURL);

			service.syncIntervalId = setInterval(()=> {
				this._refresh(service, (error) => {
					if (error) {
						console.error(error);
					}
				});
			}, Math.max(service.timeoutSeconds - 5, 10) * 1000);

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

			this._debug("requestVars", "Response xml=", body);

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

		let body = `<Channel>${channel}</Channel>`;

		this._requestUpnpService(instanceID, RENDERING_CONTROL_USN, this._renderingControlURL, "GetVolume", body, callback);
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

		this._debug("requestUpnpService", "InstanceID=", instanceID, "action=", action, "params=", params, "body=", body);
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

	processEvent(body, request, nt, sid, callback) {

		let service = this._services[sid];
		this._debug("processEvent", "body=", body, "nt=", nt, "sid=", sid, "service=", service);

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

		if (service.type === 'RenderingControl') {
			this._propertiesChanged(xml2, instanceID, RENDERING_CONTROL_EVENT_PROPS, true, RENDERING_CONTROL_XPL_NAME, (xml2, changes) => {
				let volume = xml2.valueWithPath("InstanceID.Volume@val");
				if (volume !== undefined) {
					let channel = xml2.valueWithPath("InstanceID.Volume@channel") || 'Master';
					changes[channel + "/volume"] = volume;
				}
			}, callback);
			return;
		}

		if (service.type === 'AVTransport') {
			this._propertiesChanged(xml2, instanceID, AVTRANSPORT_EVENT_PROPS, true, AVTRANSPORT_XPL_NAME, (xml2, changes) => {
				this._updateMetaDatas(changes, changes['currentTrackMetaData']);
				this._updateMetaDatas(changes, changes['AVTransportURIMetaData']);

			}, callback);
			return;
		}

		callback();
	}

	_propertiesChanged(xml2, instanceID, props, ignoreIfUndefined, bodyName, postChange, callback) {
		assert.equal(typeof(bodyName), "string", "Invalid bodyName parameter");
		assert.equal(typeof(ignoreIfUndefined), "boolean", "Invalid ignoreIfUndefined parameter");

		if (!xml2) {
			return callback();
		}

		let changes = {};
		for (var k in props) {
			let name = props[k];
			let value = xml2.valueWithPath(k);

			if (ignoreIfUndefined && value === undefined) {
				continue;
			}

			changes[name] = value;
		}

		if (typeof(postChange) === "function") {
			postChange(xml2, changes);
		}

		Async.eachOfSeries(changes, (value, name, callback) => {
			if (value === undefined || value === null) {
				value = '';
			}

			let xpl = this._engine._xpl;
			let old = this._values[name];

			//this._debug("propChanged", "name=", name, "old=", old, "new=", value);

			if (value === old) {
				return callback();
			}

			this._values[name] = value;

			var body = this._fillBody(instanceID, name, value);

			this._debug("propChanged", "Set value changed name=", name, "newValue=", value, "instanceID=", instanceID);

			xpl.sendXplTrig(body, bodyName, callback);

		}, (error) => {
			callback(error, changes);
		});
	}

	_fillBody(instanceID, name, value) {

		if (!instanceID) {
			return {
				device: this.ausn + "/",
				type: name,
				current: value
			};
		}

		return {
			device: this.ausn + "/" + instanceID,
			type: name,
			current: value
		};
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
				props = {"CurrentVolume": channel + '/volume'};

			} else {
				props = {"CurrentVolume": 'volume'};
			}

			this._propertiesChanged(xml2, instanceID, props, false, RENDERING_CONTROL_XPL_NAME, null, callback);
		});
	}

	_updateMetaDatas(changes, metaDatas) {
		if (!metaDatas) {
			return;
		}

		let title;
		let artist;
		let genre;
		let originalTrackNumber;
		let album;
		let resURL;
		let upnpClass;

		if (metaDatas && /^<DIDL-Lite/.exec(metaDatas)) {
			try {
				let xml2 = new Xmldoc.XmlDocument(metaDatas);
				title = xml2.valueWithPath("item.dc:title");
				artist = xml2.valueWithPath("item.upnp:artist");
				genre = xml2.valueWithPath("item.upnp:genre");
				album = xml2.valueWithPath("item.upnp:album");
				originalTrackNumber = xml2.valueWithPath("item.upnp:originalTrackNumber");
				resURL = xml2.valueWithPath("item.res");
				upnpClass = xml2.valueWithPath("item.upnp:class");
			} catch (x) {
				console.error(x);
			}
		}

		changes["metaData/title"] = title;
		changes["metaData/artist"] = artist;
		changes["metaData/genre"] = genre;
		changes["metaData/album"] = album;
		changes["metaData/originalTrackNumber"] = originalTrackNumber;
		if (resURL) {
			changes["AVTransportURI"] = resURL;
		}
		changes["metaData/resourceURL"] = resURL;
		changes["metaData/upnpClass"] = upnpClass;
	}

	_updatePositionInfo(instanceID, callback) {
		this.requestPositionInfo(instanceID, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updatePositionInfo", "instanceId=", instanceID); //, "RequestPosition=", xml2);

			this._propertiesChanged(xml2, instanceID, POSITION_INFOS_PROPS, false, AVTRANSPORT_XPL_NAME, (xml2, changes) => {
				this._updateMetaDatas(changes, changes['currentTrackMetaData']);
			}, callback);
		});
	}

	_updateMediaInfo(instanceID, callback) {
		this.requestMediaInfo(instanceID, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updateMediaInfo", "instanceId=", instanceID); //, "RequestPosition=", xml2);

			this._propertiesChanged(xml2, instanceID, MEDIA_INFOS_PROPS, false, AVTRANSPORT_XPL_NAME, (xml2, changes) => {
				this._updateMetaDatas(changes, changes['AVTransportURIMetaData']);
			}, callback);
		});
	}

	_updateTransportInfo(instanceID, callback) {
		this.requestTransportInfo(instanceID, (error, xml2) => {
			if (error) {
				return callback(error);
			}

			this._debug("_updateTransportInfo", "instanceId=", instanceID); //, "RequestPosition=", xml2);

			this._propertiesChanged(xml2, instanceID, TRANSPORT_INFOS_PROPS, false, AVTRANSPORT_XPL_NAME, null, callback);
		});
	}

	_installAVPooling() {

		let intervalMs = this._configuration.poolingIntervalMs;
		if (intervalMs === 0) {
			return;
		}

		this._AVIntervalId = setInterval(() => {
			if (true) {
				if (this._values['transportState'] !== 'PLAYING') {
					return;
				}

				this._updatePositionInfo(0, (error) => {
					if (error) {
						console.error(error);
					}
				});
				return;
			}

			this._updateMediaInfo(0, (error) => {
				if (error) {
					console.error(error);
				}

				this._updateTransportInfo(0, (error) => {
					if (error) {
						console.error(error);
					}

					if (this._values['transportState'] !== 'PLAYING') {
						return;
					}

					this._updatePositionInfo(0, (error) => {
						if (error) {
							console.error(error);
						}
					});
				});
			});
		}, this._configuration.poolingIntervalMs || 1000);
	}

	_installRenderingPooling() {
		/*
		 this._renderingIntervalId = setInterval(() => {

		 this._updateVolume(0, DEFAULT_CHANNEL, (error) => {
		 if (error) {
		 console.error(error);
		 }
		 });
		 }, 5000);
		 */
	}

	/**
	 *
	 * @param {string} instanceID
	 * @param {Function} callback
	 */
	stop(instanceID, callback) {

		this._debug("stop", "Stop instanceID=", instanceID);

		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "Stop", callback);
	}

	/**
	 *
	 * @param {string} instanceID
	 * @param {Function} callback
	 */
	pause(instanceID, callback) {

		this._debug("pause", "Pause instanceID=", instanceID);

		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "Pause", callback);
	}

	/**
	 *
	 * @param {string} instanceID
	 * @param {number} [speed]
	 * @param {Function} callback
	 */
	play(instanceID, speed, callback) {
		if (typeof(speed) === "function") {
			callback = speed;
			speed = undefined;

		}

		this._debug("play", "Play instanceID=", instanceID, "speed=", speed);

		if (!speed) {
			speed = 1;
		}

		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "Play", `<Speed>${speed}</Speed>`, callback);
	}

	/**
	 *
	 * @param {string} instanceID
	 * @param {string} url
	 * @param {string} metadatas
	 * @param {Function} callback
	 */
	setAVTransportURI(instanceID, url, metadatas, callback) {
		this._debug("setAVTransportURI", "Set instanceID=", instanceID, "url=", url, "metadatas=", metadatas);

		let body = `<InstanceID>${instanceID}</InstanceID><CurrentURI>${url}</CurrentURI><CurrentURIMetaData>${metadatas}</CurrentURIMetaData>`;
		this._requestUpnpService(instanceID, AVTRANSPORT_USN, this._avtControlURL, "SetAVTransportURI", body, callback);
	}

	/**
	 *
	 * @param {*} params
	 * @param {Function} callback
	 */
	prepareForConnection(remoteProtocolInfo, callback) {
		if (!this._connectionManagerURL) {
			let ex = new Error("ConnectionManager is not supported");
			callback(ex);
			return;
		}

		let body = `<RemoteProtocolInfo>${remoteProtocolInfo}</RemoteProtocolInfo>` +
			`<PeerConnectionManager></PeerConnectionManager>` +
			`<PeerConnectionID>-1</PeerConnectionID>` +
			`<Direction>Input</Direction>`;

		this._requestUpnpService(instanceID, CONNECTION_MANAGER_USN, this._connectionManagerURL, "PrepareForConnection", body, callback);

	}

	_buildMetadata(metadata) {
		var didl = Et.Element('DIDL-Lite');
		didl.set('xmlns', 'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/');
		didl.set('xmlns:dc', 'http://purl.org/dc/elements/1.1/');
		didl.set('xmlns:upnp', 'urn:schemas-upnp-org:metadata-1-0/upnp/');
		didl.set('xmlns:sec', 'http://www.sec.co.kr/');

		var item = Et.SubElement(didl, 'item');
		item.set('id', 0);
		item.set('parentID', -1);
		item.set('restricted', false);

		var OBJECT_CLASSES = {
			'audio': 'object.item.audioItem.musicTrack',
			'video': 'object.item.videoItem.movie',
			'image': 'object.item.imageItem.photo'
		}

		if (metadata.upnpClass) {
			let klass = Et.SubElement(item, 'upnp:class');
			klass.text = upnpClass;

		} else if (metadata.type) {
			let klass = Et.SubElement(item, 'upnp:class');
			klass.text = OBJECT_CLASSES[metadata.type];
		}

		if (metadata.title) {
			var title = Et.SubElement(item, 'dc:title');
			title.text = metadata.title;
		}

		if (metadata.creator) {
			var creator = Et.SubElement(item, 'dc:creator');
			creator.text = metadata.creator;
		}

		if (metadata.url && metadata.protocolInfo) {
			var res = Et.SubElement(item, 'res');
			res.set('protocolInfo', metadata.protocolInfo);
			res.text = metadata.url;
		}

		if (metadata.subtitlesUrl) {
			var captionInfo = Et.SubElement(item, 'sec:CaptionInfo');
			captionInfo.set('sec:type', 'srt');
			captionInfo.text = metadata.subtitlesUrl;

			var captionInfoEx = Et.SubElement(item, 'sec:CaptionInfoEx');
			captionInfoEx.set('sec:type', 'srt');
			captionInfoEx.text = metadata.subtitlesUrl;

			// Create a second `res` for the subtitles
			var res = Et.SubElement(item, 'res');
			res.set('protocolInfo', 'http-get:*:text/srt:*');
			res.text = metadata.subtitlesUrl;
		}

		let doc = new Et.ElementTree(didl);
		let xml = doc.write({xml_declaration: false});

		return xml;
	}

	/**
	 *
	 * @param {string} message
	 * @param {Function} callback
	 * @private
	 */
	_load(message, callback) {
		// Inspired by https://github.com/thibauts/node-upnp-mediarenderer-client
		let url = message.url;
		let contentType = message.contentType || 'video/mpeg'; // Default to something generic
		let protocolInfo = 'http-get:*:' + contentType + ':*';

		let metadata = {};
		if (typeof(message.metadata) === "string") {
			metadata = JSON.parse(message.metadata);
		}
		metadata.url = url;
		metadata.protocolInfo = protocolInfo;

		this.prepareForConnection(protocolInfo, (error, result) => {
			let instanceId;
			if (error) {
				if (error.code !== 'ENOACTION') {
					return callback(error);
				}
				//
				// If PrepareForConnection is not implemented, we keep the default (0) InstanceID
				//
			} else {
				instanceId = result.AVTransportID;
			}

			let metadatas = this._buildMetadata(metadata);
			this.setAVTransportURI(instanceId, url, metadatas, (error) => {
				if (error) {
					return callback(error);
				}

				if (message.uuid) {
					let body = {
						device: this.ausn,
						action: "loaded",
						instanceId: instanceId,
						uuid: message.uuid
					};
					xpl.sendXplTrig(body, AVTRANSPORT_XPL_NAME, callback);
					return;
				}

				callback();
			});
		});
	}

	/**
	 *
	 * @param {string} instanceID
	 * @param {string} channel
	 * @param {number} desiredVolume
	 * @param {Function} callback
	 */
	setVolume(instanceID, channel, desiredVolume, callback) {
		this._debug("setVolume", "Set volume of instanceID=", instanceID, "channel=", channel, "desiredVolume=", desiredVolume);

		if (!this._renderingControlURL) {
			let ex = new Error("RenderingControl is not supported");
			callback(ex);
			return;
		}

		if (!channel) {
			channel = DEFAULT_CHANNEL;
		}

		let body = `<Channel>${channel}</Channel><DesiredVolume>${desiredVolume}</DesiredVolume>`;

		this._requestUpnpService(instanceID, RENDERING_CONTROL_USN, this._renderingControlURL, "SetVolume", body, callback);
	}

	sendStatus(instanceID, callback) {
		callback();
	}

	processXplMessage(message, instanceId, sub, callback) {
		this._debug("Action message=", message, "instanceId=", instanceId, "sub=", sub);

		if (message.bodyName == "audio.basic") {
			switch (message.body.command) {
				case 'play':
					if (message.url) {
						this._load(message, (error) => {
							if (error) {
								return callback(error);
							}

							this.play(instanceId, message.speed, callback);
						});
						return;
					}

					this.play(instanceId, callback);
					return;

				case 'pause':
					this.pause(instanceId, callback);
					return;

				case 'stop':
					this.stop(instanceId, callback);
					return;

				case 'volume':
					this.setVolume(instanceId, sub, message.body.current, callback);
					return;

				case 'status':
					this.sendStatus(instanceId, callback);
					return;

				case 'load':
					this._load(message, (error) => {
						if (error) {
							return callback(error);
						}
						if (typeof(message.autoplay) === "string" && /^(true|1|enable|enabled)$/i.exec(message.autoplay)) {
							this.play(instanceId, message.speed, callback);
							return;
						}
						callback();
					});
					return;
			}
		}
		callback();
	}
}

module.exports = Device;