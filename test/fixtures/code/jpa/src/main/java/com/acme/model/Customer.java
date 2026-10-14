package com.acme.model;

import jakarta.persistence.*;

@Entity(name = "Customer")
@Table(name = "customers")
public class Customer extends BaseEntity {
    @Column(nullable = false, unique = true)
    private String email;
    private String fullName;
}
