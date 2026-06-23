from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.utils.astrbot_path import (
    get_astrbot_plugin_data_path,
    get_astrbot_plugin_path,
    get_astrbot_temp_path,
)

PLUGIN_NAME = "astrbot_plugin_qqwebui"


class PluginConfig(BaseModel):
    session_message_limit: int = Field(default=200)
    global_message_limit: int = Field(default=5000)
    contact_ttl: int = Field(default=300)
    group_member_ttl: int = Field(default=120)

    model_config = ConfigDict(extra="ignore")

    def __init__(self, config: AstrBotConfig):
        super().__init__(**config)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)

    @property
    def plugin_dir(self) -> Path:
        return Path(get_astrbot_plugin_path()) / PLUGIN_NAME

    @property
    def data_dir(self) -> Path:
        return Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME

    @property
    def temp_dir(self) -> Path:
        return Path(get_astrbot_temp_path()) / PLUGIN_NAME

    @property
    def media_dir(self) -> Path:
        return self.temp_dir / "media"

    @property
    def qq_face_dir(self) -> Path:
        return self.plugin_dir / "qq_face"

    @property
    def cache_store_path(self) -> Path:
        return self.data_dir / "cache_store.json"
