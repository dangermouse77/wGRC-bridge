create database d_wgrcbridge_dev;
create user wgrcbridge_dev with encrypted password '******';
grant all privileges on database d_wgrcbridge_dev to wgrcbridge_dev;
alter database d_wgrcbridge_dev owner to wgrcbridge_dev;

create database d_wgrcbridge_prod;
create user wgrcbridge_prod with encrypted password '******';
grant all privileges on database d_wgrcbridge_prod to wgrcbridge_prod;
alter database d_wgrcbridge_prod owner to wgrcbridge_prod;
