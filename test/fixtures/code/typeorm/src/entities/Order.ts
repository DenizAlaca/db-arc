import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, ManyToMany, JoinTable } from 'typeorm';
import { Customer } from './Customer';
import { Product } from './Product';

@Entity({ name: 'orders' })
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('decimal', { precision: 10, scale: 2 })
  total: number;

  @Column({ type: 'enum', enum: ['new', 'paid', 'cancelled'] })
  status: string;

  @ManyToOne(() => Customer, (customer) => customer.orders, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @ManyToMany(() => Product)
  @JoinTable({ name: 'order_products' })
  products: Product[];
}
