const mode = process.env.TEST_CRASH_MODE;

if (mode === 'uncaught_exception' || mode === 'unhandled_rejection') {
  process.on('SIGUSR2', () => {
    if (mode === 'unhandled_rejection') {
      void Promise.reject(new Error('test rejection'));
      return;
    }
    throw new Error('test exception');
  });
}
