// The "*" next to function stands for this function to be a generator which returns an iterator
const readStreamPerLine = async function*(readStream) {
  // If there is no stream return here
  if (!readStream) return;
  // Track the current stream
  let previous = '';
  for await (const chunk of readStream) {
    // Add the new chunk to the current stream
    previous += chunk;
    // End of line (\n) index
    let eolIndex;
    // This while is runned multiple times for each chunk
    while ((eolIndex = previous.indexOf('\n')) >= 0) {
      // Yields a new string which is made by the characters from 0 to "eoulIndex" in "previous"
      // This yield is an essential part of the iterator
      // It is like a "return" but it does not stop the funcion
      yield previous.slice(0, eolIndex); // This yield does no include the end of line
      // Removes the yielded slice from the "previous" including the end of line
      previous = previous.slice(eolIndex + 1);
    }
  }
  // Finally, if there is remaining data, send it
  if (previous.length > 0) {
    yield previous;
  }
};

module.exports = readStreamPerLine;
