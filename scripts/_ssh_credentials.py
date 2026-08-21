#!/usr/bin/env python3
"""Safe SSH credential loading for the operational scripts in this folder.

These scripts previously carried a hardcoded password as a literal fallback:

    PASSWORD = os.environ.get(<ENV NAME>, <A COMMITTED LITERAL>)

which meant the secret shipped in the repository and kept working even when the
environment variable was unset — so nobody noticed. This module removes the
fallback entirely: without a configured credential the scripts fail loudly
instead of quietly authenticating with a committed secret.

Resolution order:

  1. SSH private key   -- COOLIFY_SSH_KEY (path) or COOLIFY_SSH_KEY_DATA (PEM)
  2. Password from env -- COOLIFY_SSH_PASSWORD
  3. Password from a local gitignored file -- .local-sensitive-data/coolify_ssh_password.txt
     (a persistent env var set via `setx` is invisible to a session's already-running
     process tree until that process restarts; this file is read fresh every call and
     sidesteps that entirely -- see CLAUDE.md's ".local-sensitive-data/" policy)
  4. Interactive prompt -- only when a TTY is attached

Nothing here returns, logs or repr()s a secret. `SshCredentials.__repr__` is
overridden precisely so an accidental print in a caller cannot leak it.
"""

from __future__ import annotations

import contextlib
import getpass
import os
import stat
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Iterator, Optional

DEFAULT_HOST_ENV = "COOLIFY_SSH_HOST"
DEFAULT_USER_ENV = "COOLIFY_SSH_USER"
PASSWORD_ENV = "COOLIFY_SSH_PASSWORD"
KEY_PATH_ENV = "COOLIFY_SSH_KEY"
KEY_DATA_ENV = "COOLIFY_SSH_KEY_DATA"


class MissingCredentialError(RuntimeError):
    """Raised when no credential is configured. Never contains the secret."""


@dataclass
class SshCredentials:
    host: str
    user: str
    password: Optional[str] = field(default=None, repr=False)
    key_path: Optional[str] = field(default=None, repr=False)

    def __repr__(self) -> str:  # pragma: no cover - trivial
        # Deliberately opaque: a stray print() in a caller must not leak.
        how = "key" if self.key_path else "password" if self.password else "none"
        return f"SshCredentials(host={self.host!r}, user={self.user!r}, auth={how})"

    __str__ = __repr__

    @property
    def uses_key(self) -> bool:
        return bool(self.key_path)


def load_ssh_credentials(
    default_host: Optional[str] = None,
    default_user: Optional[str] = None,
    *,
    allow_prompt: bool = True,
) -> SshCredentials:
    """Resolve SSH credentials, or raise MissingCredentialError.

    `default_host` / `default_user` are non-secret conveniences so existing
    scripts keep working; the credential itself is never defaulted.
    """
    host = os.environ.get(DEFAULT_HOST_ENV) or default_host
    user = os.environ.get(DEFAULT_USER_ENV) or default_user
    if not host or not user:
        raise MissingCredentialError(
            f"SSH host/user not configured. Set {DEFAULT_HOST_ENV} and {DEFAULT_USER_ENV}."
        )

    key_path = os.environ.get(KEY_PATH_ENV)
    if key_path:
        if not os.path.isfile(key_path):
            raise MissingCredentialError(f"{KEY_PATH_ENV} points at a missing file: {key_path}")
        return SshCredentials(host=host, user=user, key_path=key_path)

    key_data = os.environ.get(KEY_DATA_ENV)
    if key_data:
        return SshCredentials(host=host, user=user, key_path=_materialize_key(key_data))

    password = os.environ.get(PASSWORD_ENV)
    if password:
        return SshCredentials(host=host, user=user, password=password)

    password_file = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        ".local-sensitive-data",
        "coolify_ssh_password.txt",
    )
    if os.path.isfile(password_file):
        with open(password_file, "r", encoding="utf-8") as handle:
            file_password = handle.read().strip()
        if file_password:
            return SshCredentials(host=host, user=user, password=file_password)

    if allow_prompt and sys.stdin.isatty():
        entered = getpass.getpass(f"SSH password for {user}@{host}: ")
        if entered:
            return SshCredentials(host=host, user=user, password=entered)

    raise MissingCredentialError(
        "No SSH credential available. Set one of "
        f"{KEY_PATH_ENV}, {KEY_DATA_ENV} or {PASSWORD_ENV}, or run interactively. "
        "There is deliberately no built-in password."
    )


def _materialize_key(pem: str) -> str:
    """Write an in-memory private key to a 0600 temp file for libraries that
    only accept a path. The caller is expected to use cleanup_temp_files()."""
    fd, path = tempfile.mkstemp(prefix="ssh_key_", suffix=".pem")
    with os.fdopen(fd, "w") as handle:
        handle.write(pem if pem.endswith("\n") else pem + "\n")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    _TEMP_FILES.append(path)
    return path


_TEMP_FILES: list[str] = []


def cleanup_temp_files() -> None:
    """Remove every temp file this module created. Safe to call repeatedly."""
    while _TEMP_FILES:
        path = _TEMP_FILES.pop()
        with contextlib.suppress(OSError):
            os.remove(path)


@contextlib.contextmanager
def ssh_credentials(
    default_host: Optional[str] = None,
    default_user: Optional[str] = None,
) -> Iterator[SshCredentials]:
    """Context manager guaranteeing temp key material is removed on every path,
    including exceptions and KeyboardInterrupt."""
    try:
        yield load_ssh_credentials(default_host, default_user)
    finally:
        cleanup_temp_files()


def connect_paramiko(client, creds: SshCredentials, timeout: int = 30):
    """Connect a paramiko SSHClient using whichever credential was resolved."""
    if creds.uses_key:
        client.connect(creds.host, username=creds.user, key_filename=creds.key_path,
                       timeout=timeout)
    else:
        client.connect(creds.host, username=creds.user, password=creds.password,
                       timeout=timeout)
    return client
