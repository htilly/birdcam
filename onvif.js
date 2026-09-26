const { Cam } = require('onvif/promises');

async function createCam(host, port, username, password) {
  const cam = new Cam({
    hostname: host,
    username: username || 'admin',
    password: password || '',
    port: port || 8899,
    timeout: 10000,
  });
  await cam.connect();
  return cam;
}

async function getImagingSettings(cam) {
  try {
    const videoSources = cam.videoSources;
    if (!videoSources || videoSources.length === 0) return null;
    const token = videoSources[0].$.token;
    // onvif lib takes { token } and returns camelCase keys
    const settings = await cam.getImagingSettings({ token });
    if (!settings) return null;
    return {
      Brightness: settings.brightness,
      Contrast: settings.contrast,
      Saturation: settings.colorSaturation,
      Sharpness: settings.sharpness,
    };
  } catch (err) {
    return null;
  }
}

async function setImagingSettings(cam, settings) {
  try {
    const videoSources = cam.videoSources;
    if (!videoSources || videoSources.length === 0) return false;
    const token = videoSources[0].$.token;
    
    // onvif lib expects { token, brightness, colorSaturation, contrast, sharpness } at the top level.
    // It skips falsy values, so pass numbers as strings to allow 0.
    const toValue = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? String(n) : undefined;
    };
    const imagingSettings = { token };
    if (settings.Brightness !== undefined) imagingSettings.brightness = toValue(settings.Brightness);
    if (settings.Contrast !== undefined) imagingSettings.contrast = toValue(settings.Contrast);
    if (settings.Saturation !== undefined) imagingSettings.colorSaturation = toValue(settings.Saturation);
    if (settings.Sharpness !== undefined) imagingSettings.sharpness = toValue(settings.Sharpness);

    await cam.setImagingSettings(imagingSettings);
    return true;
  } catch (err) {
    throw new Error(`Failed to set imaging settings: ${err.message}`);
  }
}

async function getVideoEncoderConfig(cam) {
  try {
    const profiles = cam.profiles;
    if (!profiles || profiles.length === 0) return null;
    const profile = profiles[0];
    const videoEncoderConfig = profile.videoEncoderConfiguration;
    if (!videoEncoderConfig) return null;
    
    return {
      Video: {
        Width: videoEncoderConfig.resolution?.width,
        Height: videoEncoderConfig.resolution?.height,
        FPS: videoEncoderConfig.rateControl?.frameRateLimit,
        BitRate: videoEncoderConfig.rateControl?.bitrateLimit,
        Quality: videoEncoderConfig.quality,
        Encoding: videoEncoderConfig.encoding,
        GOP: videoEncoderConfig.$.GovLength,
      },
    };
  } catch (err) {
    return null;
  }
}

async function setVideoEncoderConfig(cam, config) {
  try {
    const profiles = cam.profiles;
    if (!profiles || profiles.length === 0) {
      throw new Error('No video profiles available');
    }
    const profile = profiles[0];
    const videoEncoderConfig = profile.videoEncoderConfiguration;
    if (!videoEncoderConfig) {
      throw new Error('No video encoder configuration available');
    }
    
    const token = videoEncoderConfig.$.token;
    const updates = {};
    
    if (config.Width !== undefined || config.Height !== undefined) {
      updates.resolution = {
        width: config.Width || videoEncoderConfig.resolution?.width,
        height: config.Height || videoEncoderConfig.resolution?.height,
      };
    }
    if (config.FPS !== undefined || config.BitRate !== undefined) {
      updates.rateControl = {
        frameRateLimit: config.FPS || videoEncoderConfig.rateControl?.frameRateLimit,
        bitrateLimit: config.BitRate || videoEncoderConfig.rateControl?.bitrateLimit,
      };
    }
    if (config.Quality !== undefined) {
      updates.quality = config.Quality;
    }
    if (config.GOP !== undefined) {
      updates.$ = { ...videoEncoderConfig.$, GovLength: config.GOP };
    }
    
    await cam.setVideoEncoderConfiguration({
      token: token,
      ...updates,
    });
    return true;
  } catch (err) {
    throw new Error(`Failed to set video encoder config: ${err.message}`);
  }
}

async function getSystemDateAndTime(cam) {
  try {
    const time = await cam.getSystemDateAndTime();
    return time;
  } catch (err) {
    throw new Error(`Failed to get system time: ${err.message}`);
  }
}

async function setSystemDateAndTime(cam, date) {
  try {
    // onvif lib sends dateTime as UTCDateTime (it reads the Date via getUTC*)
    await cam.setSystemDateAndTime({
      dateTimeType: 'Manual',
      dateTime: date,
      daylightSavings: false,
    });
    return true;
  } catch (err) {
    throw new Error(`Failed to set system time: ${err.message}`);
  }
}

async function getDeviceInformation(cam) {
  try {
    const info = await cam.getDeviceInformation();
    return {
      Manufacturer: info.Manufacturer,
      Model: info.Model,
      FirmwareVersion: info.FirmwareVersion,
      SerialNumber: info.SerialNumber,
      HardwareId: info.HardwareId,
    };
  } catch (err) {
    throw new Error(`Failed to get device information: ${err.message}`);
  }
}

async function reboot(cam) {
  try {
    await cam.reboot();
    return true;
  } catch (err) {
    throw new Error(`Failed to reboot camera: ${err.message}`);
  }
}

module.exports = {
  createCam,
  getImagingSettings,
  setImagingSettings,
  getVideoEncoderConfig,
  setVideoEncoderConfig,
  getSystemDateAndTime,
  setSystemDateAndTime,
  getDeviceInformation,
  reboot,
};
