const { describe, it } = require('node:test');
const assert = require('node:assert');

const onvif = require('../../onvif');

describe('onvif.setSystemDateAndTime', () => {
  it('passes the ONVIF library options shape', async () => {
    const date = new Date('2026-04-16T12:34:56.000Z');
    let received = null;

    const cam = {
      async setSystemDateAndTime(options) {
        received = options;
      },
    };

    const result = await onvif.setSystemDateAndTime(cam, date);

    assert.strictEqual(result, true);
    assert.deepStrictEqual(received, {
      dateTimeType: 'Manual',
      daylightSavings: false,
      dateTime: date,
    });
  });
});
