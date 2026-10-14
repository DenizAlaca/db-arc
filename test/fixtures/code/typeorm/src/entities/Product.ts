import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity()
export class ProductItem {
  @PrimaryColumn()
  sku: string;

  @Column()
  title: string;
}

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ProductItem)
  item: ProductItem;
}
