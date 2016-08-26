const Xmldoc = require('xmldoc');
const fs = require('fs');

var body  = fs.readFileSync("test01.xml");

var xml = new Xmldoc.XmlDocument(body);

var sl=xml.valueWithPath("e:property.LastChange");

console.log("LastChange=",sl);

var xml2 = new Xmldoc.XmlDocument(sl);

console.log("Xml2=",xml2);


//console.log(xml.valueWithPath(xml2, "urn:schemas-upnp-org:metadata-1-0/AVT/##InstanceID", "urn:schemas-upnp-org:metadata-1-0/AVT/##CurrentPlayMode", "@val"));
