"""Trading Ideas Manager for loading and managing trading strategies.

This module provides functionality to load, validate, and access trading ideas
with their versions and parameters from a JSON configuration file.
"""

import json
from pathlib import Path
from typing import Dict, List, Optional, Any
from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_validator


class IdeaVersion(BaseModel):
    """Represents a specific version of a trading idea.

    Attributes:
        version: Version string (e.g., "1.2.3")
        description: Description of what changed in this version
        created_date: Date this version was created
        parameters: Dictionary of parameter name/value pairs
    """
    version: str = Field(..., description="Version string")
    description: str = Field(..., description="Version description")
    created_date: str = Field(..., description="Creation date (YYYY-MM-DD)")
    parameters: Dict[str, Any] = Field(default_factory=dict, description="Strategy parameters")

    @field_validator('version')
    @classmethod
    def validate_version_format(cls, v: str) -> str:
        """Validate version follows semantic versioning."""
        parts = v.split('.')
        if len(parts) != 3:
            raise ValueError("Version must be in format X.Y.Z")
        for part in parts:
            if not part.isdigit():
                raise ValueError("Version parts must be integers")
        return v

    def get_parameter(self, param_name: str, default: Any = None) -> Any:
        """Get a parameter value by name.

        Args:
            param_name: Name of the parameter
            default: Default value if parameter not found

        Returns:
            Parameter value or default
        """
        return self.parameters.get(param_name, default)


class TradingIdea(BaseModel):
    """Represents a trading idea/strategy.

    Attributes:
        idea_id: Unique identifier (used as idea_id in trades)
        title: Human-readable title
        description: Detailed description of the strategy
        versions: List of versions of this idea
    """
    idea_id: str = Field(..., description="Unique idea identifier")
    title: str = Field(..., description="Human-readable title")
    description: str = Field(..., description="Strategy description")
    versions: List[IdeaVersion] = Field(default_factory=list, description="Idea versions")

    def get_version(self, version: str) -> Optional[IdeaVersion]:
        """Get a specific version of this idea.

        Args:
            version: Version string (e.g., "1.2.3")

        Returns:
            IdeaVersion if found, None otherwise
        """
        for v in self.versions:
            if v.version == version:
                return v
        return None

    def get_latest_version(self) -> Optional[IdeaVersion]:
        """Get the most recent version of this idea.

        Returns:
            Latest IdeaVersion or None if no versions exist
        """
        if not self.versions:
            return None

        # Sort versions by semantic versioning
        def version_key(v: IdeaVersion) -> tuple:
            parts = v.version.split('.')
            return (int(parts[0]), int(parts[1]), int(parts[2]))

        return sorted(self.versions, key=version_key, reverse=True)[0]

    def list_versions(self) -> List[str]:
        """Get list of all version strings for this idea.

        Returns:
            List of version strings
        """
        return [v.version for v in self.versions]


class TradingIdeasConfig(BaseModel):
    """Configuration containing all trading ideas.

    Attributes:
        ideas: List of trading ideas
    """
    ideas: List[TradingIdea] = Field(default_factory=list, description="Trading ideas")

    def get_idea(self, idea_id: str) -> Optional[TradingIdea]:
        """Get a trading idea by ID.

        Args:
            idea_id: Idea identifier

        Returns:
            TradingIdea if found, None otherwise
        """
        for idea in self.ideas:
            if idea.idea_id == idea_id:
                return idea
        return None

    def list_ideas(self) -> List[str]:
        """Get list of all idea IDs.

        Returns:
            List of idea IDs
        """
        return [idea.idea_id for idea in self.ideas]


class TradingIdeasManager:
    """Manager for loading and accessing trading ideas from JSON configuration.

    This class provides a high-level interface for working with trading ideas,
    including loading from file, validation, and easy access to ideas/versions.
    """

    def __init__(self, config_path: Optional[Path] = None):
        """Initialize the trading ideas manager.

        Args:
            config_path: Path to trading_ideas.json file
                        (defaults to trading_ideas.json in same directory as module)
        """
        if config_path is None:
            # Default to trading_ideas.json in same directory as this module
            # In Lambda, files are in /var/task/
            config_path = Path(__file__).parent / "trading_ideas.json"

        self.config_path = config_path
        self.config: Optional[TradingIdeasConfig] = None
        self._load_config()

    def _load_config(self) -> None:
        """Load and validate trading ideas configuration from JSON file."""
        if not self.config_path.exists():
            raise FileNotFoundError(
                f"Trading ideas config not found at {self.config_path}"
            )

        with open(self.config_path, 'r') as f:
            data = json.load(f)

        self.config = TradingIdeasConfig(**data)

    def reload(self) -> None:
        """Reload configuration from file."""
        self._load_config()

    def get_idea(self, idea_id: str) -> Optional[TradingIdea]:
        """Get a trading idea by ID.

        Args:
            idea_id: Idea identifier

        Returns:
            TradingIdea if found, None otherwise
        """
        if self.config is None:
            return None
        return self.config.get_idea(idea_id)

    def get_idea_version(
        self,
        idea_id: str,
        version: Optional[str] = None
    ) -> Optional[IdeaVersion]:
        """Get a specific version of an idea.

        Args:
            idea_id: Idea identifier
            version: Version string (if None, returns latest version)

        Returns:
            IdeaVersion if found, None otherwise
        """
        idea = self.get_idea(idea_id)
        if idea is None:
            return None

        if version is None:
            return idea.get_latest_version()

        return idea.get_version(version)

    def get_parameter(
        self,
        idea_id: str,
        param_name: str,
        version: Optional[str] = None,
        default: Any = None
    ) -> Any:
        """Get a parameter value from an idea version.

        Args:
            idea_id: Idea identifier
            param_name: Parameter name
            version: Version string (if None, uses latest version)
            default: Default value if parameter not found

        Returns:
            Parameter value or default
        """
        idea_version = self.get_idea_version(idea_id, version)
        if idea_version is None:
            return default

        return idea_version.get_parameter(param_name, default)

    def list_ideas(self) -> List[str]:
        """Get list of all idea IDs.

        Returns:
            List of idea IDs
        """
        if self.config is None:
            return []
        return self.config.list_ideas()

    def list_versions(self, idea_id: str) -> List[str]:
        """Get list of all versions for an idea.

        Args:
            idea_id: Idea identifier

        Returns:
            List of version strings
        """
        idea = self.get_idea(idea_id)
        if idea is None:
            return []
        return idea.list_versions()

    def get_idea_summary(self, idea_id: str) -> Optional[Dict[str, Any]]:
        """Get a summary of an idea with all its versions.

        Args:
            idea_id: Idea identifier

        Returns:
            Dictionary with idea details or None if not found
        """
        idea = self.get_idea(idea_id)
        if idea is None:
            return None

        return {
            'idea_id': idea.idea_id,
            'title': idea.title,
            'description': idea.description,
            'versions': [
                {
                    'version': v.version,
                    'description': v.description,
                    'created_date': v.created_date,
                    'parameter_count': len(v.parameters)
                }
                for v in idea.versions
            ],
            'latest_version': idea.get_latest_version().version if idea.get_latest_version() else None
        }

    def validate_idea_reference(
        self,
        idea_id: str,
        version: str
    ) -> tuple[bool, Optional[str]]:
        """Validate that an idea and version exist.

        Args:
            idea_id: Idea identifier
            version: Version string

        Returns:
            Tuple of (is_valid, error_message)
        """
        idea = self.get_idea(idea_id)
        if idea is None:
            return False, f"Idea '{idea_id}' not found in trading_ideas.json"

        idea_version = idea.get_version(version)
        if idea_version is None:
            available = ", ".join(idea.list_versions())
            return False, f"Version '{version}' not found for idea '{idea_id}'. Available versions: {available}"

        return True, None


# Global singleton instance
_manager_instance: Optional[TradingIdeasManager] = None


def get_trading_ideas_manager() -> TradingIdeasManager:
    """Get the global trading ideas manager instance.

    Returns:
        TradingIdeasManager singleton instance
    """
    global _manager_instance
    if _manager_instance is None:
        _manager_instance = TradingIdeasManager()
    return _manager_instance


# Convenience functions for common operations

def validate_trade_idea(idea_id: str, version: str) -> tuple[bool, Optional[str]]:
    """Validate that a trade idea and version exist.

    Args:
        idea_id: Idea identifier
        version: Version string

    Returns:
        Tuple of (is_valid, error_message)
    """
    manager = get_trading_ideas_manager()
    return manager.validate_idea_reference(idea_id, version)


def get_idea_description(idea_id: str) -> Optional[str]:
    """Get the description for an idea.

    Args:
        idea_id: Idea identifier

    Returns:
        Description string or None if not found
    """
    manager = get_trading_ideas_manager()
    idea = manager.get_idea(idea_id)
    if idea is None:
        return None
    return idea.description


def get_idea_parameters(
    idea_id: str,
    version: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Get all parameters for an idea version.

    Args:
        idea_id: Idea identifier
        version: Version string (if None, uses latest)

    Returns:
        Dictionary of parameters or None if not found
    """
    manager = get_trading_ideas_manager()
    idea_version = manager.get_idea_version(idea_id, version)
    if idea_version is None:
        return None
    return idea_version.parameters
