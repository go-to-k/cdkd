exports.handler = async (event) => {
  const name = event && typeof event.name === 'string' && event.name.length > 0 ? event.name : 'world';
  return { greeting: `Hello, ${name}` };
};
