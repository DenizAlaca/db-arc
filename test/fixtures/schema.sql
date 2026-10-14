CREATE TABLE `customers` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `status` enum('active','passive') DEFAULT 'active',
  PRIMARY KEY (`id`)
);
CREATE TABLE IF NOT EXISTS public.orders (
  id bigserial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  total numeric(10,2),
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE order_lines (id serial primary key, order_id int, product_id int, qty int);
CREATE TABLE products (id serial primary key, sku varchar(40));
ALTER TABLE ONLY order_lines ADD CONSTRAINT fk_ol FOREIGN KEY (order_id) REFERENCES orders(id);
