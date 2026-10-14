import { Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn } from 'typeorm';
import { Order } from './Order';

export enum CustomerTier {
  Free = 'free',
  Pro = 'pro',
  Enterprise = 'enterprise',
}

@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'enum', enum: CustomerTier, default: CustomerTier.Free })
  tier: CustomerTier;

  @Column({ nullable: true })
  phone?: string;

  @OneToMany(() => Order, (order) => order.customer)
  orders: Order[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  get label(): string {
    return `${this.name} (${this.tier})`;
  }
}
