package com.acme

import jakarta.persistence.*

enum class Plan { FREE, PRO }

@Entity
@Table(name = "accounts")
class Account(
    @Id @GeneratedValue
    val id: Long? = null,
    @Column(name = "display_name")
    var name: String,
    @Enumerated(EnumType.STRING)
    var plan: Plan = Plan.FREE,
)

@Entity
@Table(name = "members")
class Member {
    @Id
    var id: Long = 0

    var nickname: String? = null

    @ManyToOne
    @JoinColumn(name = "account_id")
    lateinit var account: Account
}
