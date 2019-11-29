// Ora is a library used to display in console a dynamic loading status. https://www.npmjs.com/package/ora
// It shows text label next to a "loading loop" (start), a "green check" (succeed) or a "red cross" (fail)
const ora = require('ora');
// This tool converts miliseconds (ms) to a more human friendly string (e.g. 1337000000 -> 15d 11h 23m 20s)
const prettyMs = require('pretty-ms');

// This function displays in console a dynamic loading status
// It is initially called by the commands index.js, which creates a reference (spinnerRef)
// This reference is a sealed object which is then passed and used by other scripts
const getSpinner = () => {
  const instance = ora();
  // Object.freeze prevents changing any propierties or their values inside the object
  return Object.freeze({
    // "instance." variables are set here when the spinner status changes (start/succeed/fail)
    // "instance." variables are got out through the reference (e.g. spinnerRef.current.time)
    // As an exception, instance.text is set out

    // time - The time when the current instance is started
    get time() {
      return instance.time;
    },
    // ESTAS 3 FUNCIONES DE ABAJO LAS HE MOVIDO DE SITIO. ANTES ESTABAN ABAJO DEL TODO. IMAGINO QUE NO HAY PROBLEMA
    // running - True when the current instance starts and false when it succeeds or fails
    get running() {
      return instance.running;
    },
    // text - The label displayed in console for the current instance
    get text() {
      return instance.text;
    },
    set text(value) {
      return (instance.text = value);
    },
    // The following functions are called through the reference (e.g. spinnerRef.current.start())
    // They can be optionally called with a string argument (e.g. succeed('Added to database'))
    // Start - Display a loading loop
    start(...args) {
      instance.time = Date.now();
      instance.running = true;
      instance.start(...args);
      return this;
    },
    // Succeed - Display a green check
    succeed(text, ...args) {
      instance.succeed(
        // Return the time spent in this instance from start to succeed
        `${text || instance.text} (${prettyMs(Date.now() - instance.time)})`,
        ...args,
      );
      instance.running = false;
      return this;
    },
    // Fail - Display a red cross
    fail(text, ...args) {
      instance.fail(
        // Return the time spent in this instance from start to fail
        `${text || instance.text} (${prettyMs(Date.now() - instance.time)})`,
        ...args,
      );
      instance.running = false;
      return this;
    },
  });
};

module.exports = getSpinner;
