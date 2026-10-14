package com.acme.model;

import javax.persistence.Entity;
import javax.persistence.Id;

@Entity
public class Coupon {
    @Id
    private String code;
    private Integer percent;
}
