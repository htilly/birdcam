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

async function withOnvifSession(host, port, username, password, fn) {
  const cam = await createCam(host, port, username, password);
  try {
    return await fn(cam);
  } finally {
    // Cam doesn't have explicit close, but we can ignore this
  }
}

async function getImagingSettings(cam) {
  try {
    const videoSources = cam.videoSources;
    if (!videoSources || videoSources.length === 0) return null;
    const token = videoSources[0].$.token;
    const settings = await cam.getImagingSettings({ videoSourceToken: token });
    return {
      Brightness: settings.Brightness,
      Contrast: settings.Contrast,
      Saturation: settings.ColorSaturation,
      Sharpness: settings.Sharpness,
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
    
    const imagingSettings = {};
    if (settings.Brightness !== undefined) imagingSettings.Brightness = parseFloat(settings.Brightness);
    if (settings.Contrast !== undefined) imagingSettings.Contrast = parseFloat(settings.Contrast);
    if (settings.Saturation !== undefined) imagingSettings.ColorSaturation = parseFloat(settings.Saturation);
    if (settings.Sharpness !== undefined) imagingSettings.Sharpness = parseFloat(settings.Sharpness);
    
    await cam.setImagingSettings({
      videoSourceToken: token,
      ImagingSettings: imagingSettings,
    });
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
    await cam.setSystemDateAndTime({
      dateTimeType: 'Manual',
      daylightSavings: false,
      dateTime: date,
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
  withOnvifSession,
  getImagingSettings,
  setImagingSettings,
  getVideoEncoderConfig,
  setVideoEncoderConfig,
  getSystemDateAndTime,
  setSystemDateAndTime,
  getDeviceInformation,
  reboot,
};
