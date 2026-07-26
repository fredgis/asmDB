package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

func backupTimeoutOrDefault(value time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return defaultBackupTimeout
}

func readAllLimited(r io.Reader, max int64, label string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%s response too large: exceeds %d bytes", label, max)
	}
	return data, nil
}

func encryptRotationToken(platformSecret, databaseID, token string) (string, error) {
	if platformSecret == "" {
		return "", errors.New("ASMDB_PLATFORM_SECRET is required to encrypt pending rotation tokens")
	}
	aead, err := rotationTokenAEAD(platformSecret)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, []byte(token), []byte(databaseID))
	return "v1:" + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptRotationToken(platformSecret, databaseID, encrypted string) (string, error) {
	if platformSecret == "" {
		return "", errors.New("ASMDB_PLATFORM_SECRET is required to decrypt pending rotation tokens")
	}
	raw, ok := strings.CutPrefix(encrypted, "v1:")
	if !ok {
		return "", errors.New("unsupported pending token encryption version")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	aead, err := rotationTokenAEAD(platformSecret)
	if err != nil {
		return "", err
	}
	nonceSize := aead.NonceSize()
	if len(sealed) < nonceSize {
		return "", errors.New("encrypted pending token is malformed")
	}
	nonce, ciphertext := sealed[:nonceSize], sealed[nonceSize:]
	plain, err := aead.Open(nil, nonce, ciphertext, []byte(databaseID))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func rotationTokenAEAD(platformSecret string) (cipher.AEAD, error) {
	key := sha256.Sum256([]byte("asmdb pending rotation token:" + platformSecret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
