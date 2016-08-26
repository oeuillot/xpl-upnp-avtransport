class XmlDocument {

	constructor(body) {

	}

	valueWithPath(node, ...paths) {
		var ns = {};

		if (typeof(paths[0]) === "object") {
			Object.assign(ns, paths.shift());
		}

		if (!paths.length) {
			return undefined;
		}

		for (; ;) {
			var attrs = node.attr;
			if (attrs) {
				for (var name in attrs) {
					let reg = /^(xmlns)(:[.*]+)?$/.exec(name);
					if (!reg) {
						continue;
					}
					ns[attrs[name]] = (reg[2] && reg[2].slice(1)) || '';
				}
			}

			var tagName = paths.shift();
			var attr = false;
			let reg = /^@(.+)$/.exec(tagName);
			if (reg) {
				attr = true;
				tagName = reg[1];
			}

			reg = /^(.*)##(.*)$/.exec(tagName);
			if (reg) {
				var np = ns[reg[1]];
				tagName = (np && (np + ':')) + reg[2];
			}

			if (attr) {
				var attrValue = attrs[tagName];
				return attrValue;
			}

			node = node.childNamed(tagName);
			if (!node) {
				return undefined;
			}

			if (!paths.length) {
				return node.val;
			}
		}
	}

}