const contexts = new Map();

export default class LoopSampler {
    constructor(audioContext, buffer, volume, startTime) {
      this.audioContext = audioContext;
      this.buffer = buffer;
      this.startTime = startTime;
      this.volume = volume;
      this.output = this.audioContext.createGain();
      this.play = this.play.bind(this);
      this.finished = false;
      this.activeSource = null;
      this.activeEnv = null;
    }
    play(currentTime) {
      const startTime = this.startTime;
      let playTime = currentTime-startTime+0.5;
      //console.log(playTime, startTime);

      const src = this.audioContext.createBufferSource();
      const env = this.audioContext.createGain();

      src.buffer = this.buffer;
      const duration = src.buffer.duration;

      env.gain.setValueAtTime(0, playTime);
      env.gain.linearRampToValueAtTime(this.volume, playTime + 2.0);
      src.connect(env).connect(this.output);
      src.start(playTime);

      this.activeSource = src;
      this.activeEnv = env;

      // Cleanup references when sound naturally ends
      src.onended = () => {
        if (this.activeSource === src) {
          this.activeSource = null;
          this.activeEnv = null;
        }
      };

      return currentTime + duration;
    } 
    
    stop(stopTime) {
      if (this.activeSource && this.activeEnv) {
        console.log(`LoopSampler stopping at AC time: ${stopTime}`);
        this.activeEnv.gain.cancelScheduledValues(stopTime);
        this.activeEnv.gain.setValueAtTime(this.activeEnv.gain.value, stopTime);
        this.activeEnv.gain.linearRampToValueAtTime(0, stopTime + 0.05);
        this.activeSource.stop(stopTime + 0.06);
        this.activeSource = null;
        this.activeEnv = null;
      }
    }
  }