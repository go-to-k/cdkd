exports.handler = async (event) => {
  return {
    echoed: event,
    greeting: process.env.GREETING ?? 'unset',
    fromContainer: true,
  };
};
