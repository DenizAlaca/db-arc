package com.acme.model;

public enum OrderStatus {
    NEW,
    PAID("p"),
    SHIPPED;

    OrderStatus() {}
    OrderStatus(String s) {}
}
