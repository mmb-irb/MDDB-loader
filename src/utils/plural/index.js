const exceptions = new Map([
  ['analysis', 'analyses'],
  ['Analysis', 'Analyses'],
]);

const plural = (word, count = 1, prepend = false) => {
  let output;
  if (count <= 1) {
    output = word;
  } else {
    const irregular = exceptions.get(word);
    output = irregular || `${word}s`;
  }
  if (prepend) output = `${count} ${output}`;
  return output;
};

module.exports = plural;
