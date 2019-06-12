const ora = require('ora');
const prettyMs = require('pretty-ms');

// wrapper to abstract common custom logic
const getSpinner = () => {
  const instance = ora();
  return Object.freeze({
    get time() {
      return instance.time;
    },
    start(...args) {
      instance.time = Date.now();
      instance.running = true;
      instance.start(...args);
      return this;
    },
    succeed(text, ...args) {
      instance.succeed(
        `${text || instance.text} (${prettyMs(Date.now() - instance.time)})`,
        ...args,
      );
      instance.running = false;
      return this;
    },
    fail(text, ...args) {
      instance.fail(
        `${text || instance.text} (${prettyMs(Date.now() - instance.time)})`,
        ...args,
      );
      instance.running = false;
      return this;
    },
    get text() {
      return instance.text;
    },
    set text(value) {
      return (instance.text = value);
    },
  });
};

module.exports = getSpinner;
