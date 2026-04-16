INSERT INTO license_holders (id, name, royalty_rate)
VALUES
(gen_random_uuid(), 'Howard University', 0.12),
(gen_random_uuid(), 'Jackson State University', 0.12);

INSERT INTO products (id, name, sku, price)
VALUES
(gen_random_uuid(), 'Howard University Football Vase', 'HU-FBV-001', 69.99);

INSERT INTO consultants (id, name, email, commission_rate)
VALUES
(gen_random_uuid(), 'Test Consultant', 'consultant@test.com', 0.10);