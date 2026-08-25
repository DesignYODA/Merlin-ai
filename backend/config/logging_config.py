import logging
import logging.handlers
import os

_LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
os.makedirs(_LOG_DIR, exist_ok=True)

_FMT = logging.Formatter(
    "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)


def configure_logging() -> None:
    root = logging.getLogger()
    if any(isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
        return

    root.setLevel(logging.DEBUG)

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(_FMT)
    root.addHandler(ch)

    fh = logging.handlers.RotatingFileHandler(
        os.path.join(_LOG_DIR, "merlin.log"),
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(_FMT)
    root.addHandler(fh)

    # httpx/httpcore log every wire-level event (TLS handshake, full request/response
    # headers, body chunk boundaries) at DEBUG — with root at DEBUG that's dumped to
    # disk synchronously for every single external API call (HubSpot, Fireflies, Groq,
    # Anthropic), which adds real I/O overhead under load. Keep our own app loggers at
    # DEBUG; silence these two to WARNING.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str = "merlin") -> logging.Logger:
    return logging.getLogger(name)
