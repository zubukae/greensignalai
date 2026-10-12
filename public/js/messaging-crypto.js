(function () {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const iterations = 310000;

  function toBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function randomRecoveryKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function deriveVaultKey(recoveryKey, salt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(recoveryKey), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function createUserKeys(recoveryKey) {
    const encryptionPair = await crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);
    const signingPair = await crypto.subtle.generateKey({
      name: 'RSA-PSS',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['sign', 'verify']);
    const publicKey = await crypto.subtle.exportKey('jwk', encryptionPair.publicKey);
    const signingPublicKey = await crypto.subtle.exportKey('jwk', signingPair.publicKey);
    const privateKeys = {
      encryption: await crypto.subtle.exportKey('jwk', encryptionPair.privateKey),
      signing: await crypto.subtle.exportKey('jwk', signingPair.privateKey)
    };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const vaultKey = await deriveVaultKey(recoveryKey, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      vaultKey,
      encoder.encode(JSON.stringify(privateKeys))
    );

    publicKey.alg = 'RSA-OAEP-256';
    signingPublicKey.alg = 'PS256';
    return {
      publicKey,
      signingPublicKey,
      privateKeys: {
        encryption: encryptionPair.privateKey,
        signing: signingPair.privateKey
      },
      privateKeyVault: {
        version: 1,
        iterations,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(new Uint8Array(ciphertext))
      }
    };
  }

  async function unlockPrivateKey(recoveryKey, publicKey, vault) {
    if (!vault || vault.version !== 1 || vault.iterations !== iterations) {
      throw new Error('This encrypted key backup uses an unsupported version.');
    }
    const vaultKey = await deriveVaultKey(recoveryKey, fromBase64(vault.salt));
    const privateKeyJson = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(vault.iv) },
      vaultKey,
      fromBase64(vault.ciphertext)
    );
    const privateKeys = JSON.parse(decoder.decode(privateKeyJson));
    const [encryption, signing] = await Promise.all([
      crypto.subtle.importKey(
        'jwk',
        privateKeys.encryption,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt']
      ),
      crypto.subtle.importKey(
        'jwk',
        privateKeys.signing,
        { name: 'RSA-PSS', hash: 'SHA-256' },
        false,
        ['sign']
      )
    ]);
    return { encryption, signing };
  }

  function signingPayload(message, senderId) {
    const sortedKeys = {};
    for (const keyId of Object.keys(message.encryptedKeys).sort()) sortedKeys[keyId] = message.encryptedKeys[keyId];
    return JSON.stringify({
      senderId,
      channel: message.channel,
      text: message.text,
      encryptionIv: message.encryptionIv,
      encryptedKeys: sortedKeys,
      encryptionVersion: message.encryptionVersion
    });
  }

  async function keyFingerprint(jwk) {
    const material = JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(material)));
    return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  }

  async function trustRecipientKeys(recipients) {
    for (const recipient of recipients) {
      for (const [kind, jwk] of [['encryption', recipient.publicKey], ['signing', recipient.signingPublicKey]]) {
        const storageKey = `greensignal_e2ee_${kind}:${recipient.id}`;
        const fingerprint = await keyFingerprint(jwk);
        const trustedFingerprint = localStorage.getItem(storageKey);
        if (trustedFingerprint && trustedFingerprint !== fingerprint) {
          throw new Error(`A ${kind} identity key changed for a conversation member. Verify it out-of-band before continuing.`);
        }
        if (!trustedFingerprint) localStorage.setItem(storageKey, fingerprint);
      }
    }
  }

  async function assertTrustedSigningKey(userId, signingPublicKey) {
    const storageKey = `greensignal_e2ee_signing:${userId}`;
    const fingerprint = await keyFingerprint(signingPublicKey);
    const trustedFingerprint = localStorage.getItem(storageKey);
    if (trustedFingerprint && trustedFingerprint !== fingerprint) {
      throw new Error('The sender signing key changed. Verify their identity out-of-band before reading this message.');
    }
    if (!trustedFingerprint) localStorage.setItem(storageKey, fingerprint);
  }

  async function encryptMessage(plaintext, channel, senderId, recipients, signingPrivateKey) {
    if (!recipients.length) throw new Error('This conversation has no encryption recipients.');
    const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const rawKey = await crypto.subtle.exportKey('raw', contentKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      contentKey,
      encoder.encode(plaintext)
    );
    const encryptedKeys = {};
    await Promise.all(recipients.map(async recipient => {
      const key = await crypto.subtle.importKey(
        'jwk',
        recipient.publicKey,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt']
      );
      const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, rawKey);
      encryptedKeys[recipient.id] = toBase64(new Uint8Array(wrappedKey));
    }));
    const message = {
      channel,
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      encryptionIv: toBase64(iv),
      encryptedKeys,
      encryptionVersion: 1
    };
    message.text = message.ciphertext;
    message.encryptionSignature = toBase64(new Uint8Array(await crypto.subtle.sign(
      { name: 'RSA-PSS', saltLength: 32 },
      signingPrivateKey,
      encoder.encode(signingPayload(message, senderId))
    )));
    return message;
  }

  async function decryptMessage(message, userId, senderId, privateKeys, signingPublicJwk) {
    const wrappedKey = message.encryptedKeys && message.encryptedKeys[userId];
    if (!wrappedKey || !message.encryptionIv || !message.encryptionSignature || !signingPublicJwk) {
      throw new Error('This message does not have a key for this account.');
    }
    await assertTrustedSigningKey(senderId, signingPublicJwk);
    const signingPublicKey = await crypto.subtle.importKey(
      'jwk',
      signingPublicJwk,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const validSignature = await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 32 },
      signingPublicKey,
      fromBase64(message.encryptionSignature),
      encoder.encode(signingPayload(message, senderId))
    );
    if (!validSignature) throw new Error('Message signature is invalid.');

    const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKeys.encryption, fromBase64(wrappedKey));
    const contentKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(message.encryptionIv) },
      contentKey,
      fromBase64(message.text)
    );
    return decoder.decode(plaintext);
  }

  window.MessagingCrypto = {
    randomRecoveryKey,
    createUserKeys,
    unlockPrivateKey,
    trustRecipientKeys,
    encryptMessage,
    decryptMessage
  };
})();
