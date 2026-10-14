import enum
from typing import Optional

from sqlalchemy import Column, Integer, String, ForeignKey, Enum, Table
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlmodel import SQLModel, Field


class Base(DeclarativeBase):
    pass


class Role(enum.Enum):
    admin = "admin"
    viewer = "viewer"


user_groups = Table(
    "user_groups",
    Base.metadata,
    Column("user_id", ForeignKey("users.id"), primary_key=True),
    Column("group_id", ForeignKey("groups.id"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String(120), nullable=False, unique=True)
    role = Column(Enum(Role), nullable=False)
    posts = relationship("Post", back_populates="author")


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[Optional[str]]
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    state = Column("post_state", Enum("draft", "live", name="post_state"))
    author: Mapped["User"] = relationship(back_populates="posts")


class Team(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)


class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    age: int | None = None
    team_id: Optional[int] = Field(default=None, foreign_key="team.id")
