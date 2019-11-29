// This script is called when the standard NGL library is needed (https://www.npmjs.com/package/ngl)
// This script executes a few logic before returning the required library

// if we hadn't done so before...
if (!global.window) {
  // get a fake DOM from jsdom
  const dom = new (require('jsdom')).JSDOM();
  // put on the global object all the things NGL asks for
  global.window = dom.window;
  global.Blob = dom.window.Blob;
  global.File = dom.window.File;
  global.FileReader = dom.window.FileReader;
}

module.exports = require('ngl');
