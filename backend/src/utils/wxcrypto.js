const crypto = require('crypto');
const xml2js = require('xml2js');

// normalizeCryptoText
// 是什么：加解密文本标准化函数。
// 做什么：将输入统一转换为去首尾空白的字符串，兼容数组与空值。
// 为什么：回调参数可能出现数组或额外空白，直接参与验签/解密会导致失败。
const normalizeCryptoText = (value) => {
  if (Array.isArray(value)) {
    return normalizeCryptoText(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
};

// parseNetworkOrderLength
// 是什么：网络字节序消息长度解析函数。
// 做什么：从给定偏移读取 4 字节无符号整数（大端），得到消息体长度。
// 为什么：企业微信加密消息规范要求按 `msg_len` 精确截取消息，不能仅依赖尾部截断。
const parseNetworkOrderLength = (buffer, offset) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Invalid buffer when parsing message length.');
  }

  if (offset < 0 || offset + 4 > buffer.length) {
    throw new Error('Invalid message length offset.');
  }

  return buffer.readUInt32BE(offset);
};

class WXBizMsgCrypt {
  constructor(token, encodingAesKey, corpId) {
    this.token = normalizeCryptoText(token);
    this.encodingAesKey = normalizeCryptoText(encodingAesKey);
    this.corpId = normalizeCryptoText(corpId);
    this.aesKey = Buffer.from(`${this.encodingAesKey}=`, 'base64');
    this.iv = this.aesKey.slice(0, 16);

    if (this.aesKey.length !== 32) {
      throw new Error('Invalid EncodingAESKey length. Expected 43-char base64 key.');
    }

    if (!this.token || !this.corpId) {
      throw new Error('Invalid WeCom callback config. TOKEN and CORP_ID are required.');
    }
  }

  getSignature(timestamp, nonce, encrypt) {
    const shasum = crypto.createHash('sha1');
    const normalizedTimestamp = normalizeCryptoText(timestamp);
    const normalizedNonce = normalizeCryptoText(nonce);
    const normalizedEncrypt = normalizeCryptoText(encrypt);
    const arr = [this.token, normalizedTimestamp, normalizedNonce, normalizedEncrypt].sort();
    shasum.update(arr.join(''));
    return shasum.digest('hex');
  }

  decrypt(text) {
    const encryptedText = normalizeCryptoText(text);

    if (!encryptedText) {
      throw new Error('Encrypted text is empty.');
    }

    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    let deciphered = Buffer.concat([decipher.update(encryptedText, 'base64'), decipher.final()]);

    // Remove PKCS#7 padding
    let pad = deciphered[deciphered.length - 1];
    if (pad < 1 || pad > 32) {
      pad = 0;
    }
    deciphered = deciphered.slice(0, deciphered.length - pad);

    const randomBytesLength = 16;
    const msgLengthFieldLength = 4;
    const messageLengthOffset = randomBytesLength;
    const messageStartOffset = randomBytesLength + msgLengthFieldLength;
    const corpIdBuffer = Buffer.from(this.corpId, 'utf8');

    if (deciphered.length < messageStartOffset + corpIdBuffer.length) {
      throw new Error('Invalid decrypted message length.');
    }

    const messageLength = parseNetworkOrderLength(deciphered, messageLengthOffset);
    const messageEndOffset = messageStartOffset + messageLength;
    const corpIdStartOffset = messageEndOffset;
    const corpIdEndOffset = corpIdStartOffset + corpIdBuffer.length;

    if (messageLength < 0 || corpIdEndOffset > deciphered.length) {
      throw new Error('Invalid message length parsed from decrypted payload.');
    }

    if (corpIdEndOffset !== deciphered.length) {
      throw new Error('Invalid decrypted payload framing.');
    }

    const fromCorpId = deciphered.slice(corpIdStartOffset, corpIdEndOffset);

    if (!fromCorpId.equals(corpIdBuffer)) {
      throw new Error('CorpId mismatch in decrypted message.');
    }

    const content = deciphered.slice(messageStartOffset, messageEndOffset);
    return content.toString('utf8');
  }

  async parseXML(xmlString) {
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xmlString);
    return result.xml;
  }
}

module.exports = WXBizMsgCrypt;
