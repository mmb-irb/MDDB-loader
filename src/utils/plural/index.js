const exceptions = new Map([
  ['analysis', 'analyses'],
  ['Analysis', 'Analyses'],
]);

// Plural returns a single string which pluralizes a word when the numeric argument is bigger than 1
// Optionally it can also display the number (e.g. "1 unicorn", "2 unicorns", "unicorns")
// A few exceptional word will be not modified. They are listed above.
const plural = (word, count = 1, prepend = false) => {
  let output;
  // Note that count == 0 also retuns plural
  if (count == 1) {
    // Singular
    output = word;
  } else {
    // Plural
    const irregular = exceptions.get(word); // Check if it is one of the excepctional words
    output = irregular || `${word}s`;
  }
  // When the option "prepend" is true, add the count number to the string
  if (prepend) output = `${count} ${output}`;
  return output;
};

module.exports = plural;
