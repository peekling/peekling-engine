declare module "pngjs" {
  export class PNG {
    static sync: {
      read(value: Buffer, options?: { checkCRC?: boolean }): PNG;
      write(value: PNG, options?: Record<string, unknown>): Buffer;
    };
    width: number;
    height: number;
    data: Buffer;
    constructor(options: { width: number; height: number });
  }
}
