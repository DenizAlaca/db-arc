<?php

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('approver_id')->nullable()->constrained('users');
            $table->unsignedBigInteger('coupon_id')->nullable();
            $table->decimal('total', 10, 2);
            $table->softDeletes();
            $table->timestamps();
            $table->foreign('coupon_id')->references('id')->on('coupons');
        });
        Schema::table('orders', function (Blueprint $table) {
            $table->string('note')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('orders');
    }
};
