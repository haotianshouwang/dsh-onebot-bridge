const DEFAULT_SOURCE = 'dsh-onebot-bridge';

export const QR_STATES = Object.freeze({
  IDLE: 'idle',
  REQUESTING_QR: 'requesting_qr',
  WAITING_SCAN: 'waiting_scan',
  SCANNED: 'scanned',
  AUTHENTICATED: 'authenticated',
  EXPIRED: 'expired',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

async function loadSdk() {
  return import('@tencent-connect/qqbot-connector');
}

function errorText(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' ? '未安装可选的 QQ 二维码 SDK；可改用 AppID/AppSecret' : 'QQ 二维码绑定失败，请检查 SDK、网络与应用授权后重试';
}

export class QQQrConnector {
  constructor({sdkLoader = loadSdk, onChange = () => {}, onSuccess = async () => {}, now = () => Date.now()} = {}) {
    this.sdkLoader = sdkLoader;
    this.onChange = onChange;
    this.onSuccess = onSuccess;
    this.now = now;
    this.generation = 0;
    this.stopFn = null;
    this.activeGeneration = 0;
    this.current = {state: QR_STATES.IDLE, qrUrl: '', error: '', startedAt: 0, updatedAt: 0};
  }

  get running() {
    return [QR_STATES.REQUESTING_QR, QR_STATES.WAITING_SCAN, QR_STATES.SCANNED, QR_STATES.EXPIRED].includes(this.current.state);
  }

  snapshot() {
    return {...this.current, running: this.running};
  }

  publish(patch) {
    this.current = {...this.current, ...patch, updatedAt: this.now()};
    try { this.onChange(this.snapshot()); } catch {}
    return this.snapshot();
  }

  async start({source = DEFAULT_SOURCE} = {}) {
    if (this.running) throw new Error('已有 QQ 二维码登录会话正在运行');
    this.stopCurrentTask();
    const generation = ++this.generation;
    this.activeGeneration = generation;
    this.stopFn = null;
    this.publish({state: QR_STATES.REQUESTING_QR, qrUrl: '', error: '', startedAt: this.now()});
    let sdk;
    try {
      sdk = await this.sdkLoader();
      if (generation !== this.activeGeneration) return this.snapshot();
      if (typeof sdk?.startQrConnect !== 'function') throw new Error('QQ 二维码 SDK 缺少 startQrConnect 接口');
      const stop = sdk.startQrConnect({
        onQrDisplayed: url => {
          if (generation !== this.activeGeneration || this.current.state === QR_STATES.SCANNED) return;
          this.publish({state: QR_STATES.WAITING_SCAN, qrUrl: String(url || ''), error: ''});
        },
        onSuccess: credentials => {
          if (generation !== this.activeGeneration) return;
          void this.complete(generation, credentials);
        },
        onFailure: error => {
          if (generation !== this.activeGeneration || this.current.state === QR_STATES.SCANNED) return;
          this.fail(generation, error);
        },
        onQrExpired: () => {
          if (generation !== this.activeGeneration || this.current.state === QR_STATES.SCANNED) return;
          this.publish({state: QR_STATES.EXPIRED, qrUrl: ''});
        }
      }, {displayQrCodeToConsole: false, source});
      if (typeof stop !== 'function') throw new Error('QQ 二维码 SDK 未返回可调用的 stop 函数');
      if (generation !== this.activeGeneration) {
        stop();
        return this.snapshot();
      }
      if (this.current.state === QR_STATES.SCANNED) {
        stop();
        return this.snapshot();
      }
      this.stopFn = stop;
      return this.snapshot();
    } catch (error) {
      this.fail(generation, error);
      throw new Error(errorText(error));
    }
  }

  async complete(generation, credentials) {
    if (generation !== this.activeGeneration) return;
    if (this.current.state === QR_STATES.SCANNED) return;
    this.publish({state: QR_STATES.SCANNED, qrUrl: '', error: ''});
    this.stopCurrentTask();
    try {
      await this.onSuccess(credentials);
      if (generation === this.activeGeneration) {
        this.activeGeneration = 0;
        this.publish({state: QR_STATES.AUTHENTICATED, qrUrl: '', error: ''});
      }
    } catch (error) {
      this.fail(generation, error);
    }
  }

  fail(generation, error) {
    if (generation !== this.activeGeneration) return;
    this.activeGeneration = 0;
    this.stopCurrentTask();
    this.publish({state: QR_STATES.FAILED, qrUrl: '', error: errorText(error)});
  }

  stopCurrentTask() {
    const stop = this.stopFn;
    this.stopFn = null;
    if (stop) {
      try { stop(); } catch {}
    }
  }

  cancel() {
    if (!this.running && !this.stopFn) return this.snapshot();
    this.activeGeneration = ++this.generation;
    this.stopCurrentTask();
    return this.publish({state: QR_STATES.CANCELLED, qrUrl: '', error: ''});
  }

  stop() {
    this.activeGeneration = ++this.generation;
    this.stopCurrentTask();
    this.current = {state: QR_STATES.IDLE, qrUrl: '', error: '', startedAt: 0, updatedAt: this.now()};
    try { this.onChange(this.snapshot()); } catch {}
    return this.snapshot();
  }
}
