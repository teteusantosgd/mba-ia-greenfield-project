export class UploadNotFoundError extends Error {
  constructor(key: string) {
    super(`Multipart upload for ${key} no longer exists`);
    this.name = 'UploadNotFoundError';
  }
}

export class InvalidPartsError extends Error {
  constructor(key: string) {
    super(`Storage rejected the part list for ${key}`);
    this.name = 'InvalidPartsError';
  }
}
