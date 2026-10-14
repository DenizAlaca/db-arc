package models

import (
	"time"

	"gorm.io/gorm"
)

type Role string

const (
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

type Company struct {
	ID   uint   `gorm:"primaryKey"`
	Name string `gorm:"size:255;not null"`
}

type User struct {
	gorm.Model
	Name        string
	Email       *string `gorm:"uniqueIndex"`
	Role        Role
	CompanyID   uint
	Company     Company
	CreditCards []CreditCard
	Languages   []Language `gorm:"many2many:user_languages;"`
	Ignored     string     `gorm:"-"`
}

type CreditCard struct {
	gorm.Model
	Number string
	UserID uint
}

type Language struct {
	Code string `gorm:"primaryKey;column:lang_code;type:varchar(8)"`
	Kind string `gorm:"type:enum('natural','programming')"`
	At   time.Time
}

func (Language) TableName() string { return "langs" }
