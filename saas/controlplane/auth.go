package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

const entraScopeName = "console.access"

type verifiedAccessToken struct {
	Groups []string
	Scopes []string
}

type accessTokenVerifier interface {
	Verify(context.Context, string) (verifiedAccessToken, error)
}

type oidcAccessTokenVerifier struct {
	verifier *oidc.IDTokenVerifier
}

func newOIDCAccessTokenVerifier(ctx context.Context, cfg config) (*oidcAccessTokenVerifier, error) {
	if cfg.EntraTenantID == "" || cfg.EntraClientID == "" {
		return nil, fmt.Errorf("missing Entra tenant or client id")
	}
	issuer := fmt.Sprintf("https://login.microsoftonline.com/%s/v2.0", cfg.EntraTenantID)
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	return &oidcAccessTokenVerifier{
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.EntraClientID}),
	}, nil
}

func (v *oidcAccessTokenVerifier) Verify(ctx context.Context, raw string) (verifiedAccessToken, error) {
	token, err := v.verifier.Verify(ctx, raw)
	if err != nil {
		return verifiedAccessToken{}, err
	}
	var claims struct {
		Groups []string `json:"groups"`
		Scope  string   `json:"scp"`
	}
	if err := token.Claims(&claims); err != nil {
		return verifiedAccessToken{}, err
	}
	return verifiedAccessToken{
		Groups: claims.Groups,
		Scopes: strings.Fields(claims.Scope),
	}, nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
